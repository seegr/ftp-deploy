import prettyBytes from "pretty-bytes";
import type * as ftp from "basic-ftp";
import * as basicFtp from "basic-ftp";
import fs from "fs";
import {DiffResult, ErrorCode, IFilePath, currentSyncFileVersion} from "./types";
import { ILogger, pluralize, retryRequest, ITimings } from "./utilities";

export async function ensureDir(client: ftp.Client, logger: ILogger, timings: ITimings, folder: string): Promise<void> {
    timings.start("changingDir");
    logger.verbose(`  changing dir to ${folder}`);

    await retryRequest(logger, async () => await client.ensureDir(folder));

    logger.verbose(`  dir changed`);
    timings.stop("changingDir");
}

interface ISyncProvider {
    createFolder(folderPath: string): Promise<void>;
    removeFile(filePath: string): Promise<void>;
    removeFolder(folderPath: string): Promise<void>;

    /**
     * @param file file can include folder(s)
     * Note working dir is modified and NOT reset after upload
     * For now we are going to reset it - but this will be removed for performance
     */
    uploadFile(filePath: string, type: "upload" | "replace"): Promise<void>;

    syncLocalToServer(diffs: DiffResult): Promise<void>;
}

export class FTPSyncProvider implements ISyncProvider {
    constructor(
      client: ftp.Client,
      logger: ILogger,
      timings: ITimings,
      localPath: string,
      serverPath: string,
      stateName: string,
      dryRun: boolean,
      server: string,
      username: string,
      password: string
    ) {
        this.client = client;
        this.logger = logger;
        this.timings = timings;
        this.localPath = localPath;
        this.serverPath = serverPath;
        this.stateName = stateName;
        this.dryRun = dryRun;
        this.server = server;
        this.username = username;
        this.password = password;
    }

    private client: ftp.Client;
    private logger: ILogger;
    private timings: ITimings;
    private localPath: string;
    private serverPath: string;
    private dryRun: boolean;
    private server: string;
    private username: string;
    private password: string;
    private stateName: string;
    private lastNoopTime = Date.now();

    private async reconnect() {
        this.logger.verbose("Reconnecting to FTP server...");
        try {
            this.client.close(); // Zavři staré připojení
        } catch (error: any) {
            this.logger.verbose(`Error while closing client (ignored): ${error.message}`);
        }

        this.client = new basicFtp.Client(this.client.ftp.timeout); // Vytvoř nový klient
        await this.client.access({
            host: this.server,
            user: this.username,
            password: this.password,
            secure: true,
            secureOptions: {
                rejectUnauthorized: false,
            },
        });
        this.logger.verbose("Reconnected successfully.");
    }

    private async sendNoopIfNeeded(force = false) {
        const now = Date.now();
        if (now - this.lastNoopTime > 5000 || force) {
            try {
                await this.client.send("NOOP");
                this.logger.all("{Hey Mr. FTP ... I'm still here!!!} - 💩👉🏻 ");
                this.lastNoopTime = now;
            } catch (error) {
                if (error instanceof Error) {
                    this.logger.verbose(`Failed to send NOOP: ${error.message}`);
                } else {
                    this.logger.verbose("Failed to send NOOP: Unknown error");
                }
            }
        }
    }

    private async safeOperation(operation: any, retries = 3): Promise<any> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (error instanceof Error) {
                    lastError = error;

                    if (error.message.includes("Client is closed")) {
                        this.logger.verbose("Client closed, attempting to reconnect...");
                        await this.reconnect();
                    }

                    console.error(`Operation failed (attempt ${attempt + 1}/${retries}): ${error.message}`);
                } else {
                    lastError = new Error("Unknown error occurred");
                    console.error(`Operation failed (attempt ${attempt + 1}/${retries}): Unknown error`);
                }

                if (attempt < retries - 1) {
                    console.log("Retrying...");
                }
            }
        }

        throw new Error(`Operation failed after ${retries} attempts: ${lastError?.message}`);
    }

    private async updateStateFile(localPath: string, stateName: string, diffs: DiffResult): Promise<void> {
        const stateFilePath = `${localPath}${stateName}`;
        const stateData = {
            description: "Updated state after partial sync",
            version: currentSyncFileVersion,
            generatedTime: new Date().getTime(),
            data: [
                ...diffs.upload.map(file => ({ ...file, action: "upload" })),
                ...diffs.delete.map(file => ({ ...file, action: "delete" })),
                ...diffs.replace.map(file => ({ ...file, action: "replace" })),
            ],
        };

        fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 4), { encoding: "utf8" });
        this.logger.verbose(`State file updated at "${stateFilePath}"`);
    }

    /**
     * Converts a file path (ex: "folder/otherfolder/file.txt") to an array of folder and a file path
     * @param fullPath 
     */
    private getFileBreadcrumbs(fullPath: string): IFilePath {
        // todo see if this regex will work for nonstandard folder names
        // todo what happens if the path is relative to the root dir? (starts with /)
        const pathSplit = fullPath.split("/");
        const file = pathSplit?.pop() ?? ""; // get last item
        const folders = pathSplit.filter(folderName => folderName != "");

        return {
            folders: folders.length === 0 ? null : folders,
            file: file === "" ? null : file
        };
    }

    /**
     * Navigates up {dirCount} number of directories from the current working dir
     */
    private async upDir(dirCount: number | null | undefined): Promise<void> {
        if (typeof dirCount !== "number") {
            return;
        }

        // navigate back to the starting folder
        for (let i = 0; i < dirCount; i++) {
            await retryRequest(this.logger, async () => await this.client.cdup());
        }
    }

    async createFolder(folderPath: string) {
        this.logger.all(`creating folder "${folderPath + "/"}"`);

        if (this.dryRun === true) {
            return;
        }

        await this.sendNoopIfNeeded();

        const path = this.getFileBreadcrumbs(folderPath + "/");

        if (path.folders === null) {
            this.logger.verbose(`  no need to change dir`);
        } else {
            await this.safeOperation(async () =>
              ensureDir(this.client, this.logger, this.timings, path.folders!.join("/"))
            );
        }

        // Update state.json after successful operation
        const diffs: DiffResult = {
            upload: [{ type: "folder", name: folderPath, size: undefined }],
            delete: [],
            replace: [],
            same: [],
            sizeUpload: 0,
            sizeDelete: 0,
            sizeReplace: 0,
        };
        await this.updateStateFile(this.localPath, this.stateName, diffs);

        // navigate back to the root folder
        await this.upDir(path.folders?.length);

        this.logger.verbose(`  completed`);
    }

    async removeFile(filePath: string) {
        this.logger.all(`removing "${filePath}"`);

        if (this.dryRun === false) {
            try {
                await this.safeOperation(async () => this.client.remove(filePath));
            } catch (e: any) {
                if (e.code === ErrorCode.FileNotFoundOrNoAccess) {
                    this.logger.standard("File not found or you don't have access to the file - skipping...");
                } else {
                    throw e;
                }
            }
        }

        this.logger.verbose(`  file removed`);
        this.logger.verbose(`  completed`);
    }

    async removeFolder(folderPath: any) {
        // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
        const absoluteFolderPath = "/" + (this.serverPath.startsWith("./") ? this.serverPath.replace("./", "") : this.serverPath) + folderPath;
        this.logger.all(`removing folder "${absoluteFolderPath}"`);

        if (this.dryRun === false) {
            await this.safeOperation(async () =>
              retryRequest(this.logger, async () => await this.client.removeDir(absoluteFolderPath))
            );
        }

        this.logger.verbose(`  completed`);
    }

    async uploadFile(filePath: string, type: "upload" | "replace" = "upload") {
        const typePresent = type === "upload" ? "uploading" : "replacing";
        const typePast = type === "upload" ? "uploaded" : "replaced";
        this.logger.all(`${typePresent} "${filePath}"`);

        await this.sendNoopIfNeeded();

        if (this.dryRun === false) {
            await this.safeOperation(async () =>
              this.client.uploadFrom(this.localPath + filePath, filePath)
            );
        }

        this.logger.verbose(`  file ${typePast}`);
    }

    async syncLocalToServer(diffs: DiffResult) {
        const totalCount = diffs.delete.length + diffs.upload.length + diffs.replace.length;

        this.logger.all(`----------------------------------------------------------------`);
        this.logger.all(`Making changes to ${totalCount} ${pluralize(totalCount, "file/folder", "files/folders")} to sync server state`);
        this.logger.all(`Uploading: ${prettyBytes(diffs.sizeUpload)} -- Deleting: ${prettyBytes(diffs.sizeDelete)} -- Replacing: ${prettyBytes(diffs.sizeReplace)}`);
        this.logger.all(`----------------------------------------------------------------`);

        try {
            // create new folders
            for (const file of diffs.upload.filter(item => item.type === "folder")) {
                await this.createFolder(file.name);
            }

            // upload new files
            for (const file of diffs.upload.filter(item => item.type === "file").filter(item => item.name !== this.stateName)) {
                await this.uploadFile(file.name, "upload");
            }

            // replace new files
            for (const file of diffs.replace.filter(item => item.type === "file").filter(item => item.name !== this.stateName)) {
                await this.uploadFile(file.name, "replace");
            }

            // delete old files
            for (const file of diffs.delete.filter(item => item.type === "file")) {
                await this.removeFile(file.name);
            }

            // delete old folders
            for (const file of diffs.delete.filter(item => item.type === "folder")) {
                await this.removeFolder(file.name);
            }

            this.logger.all(`----------------------------------------------------------------`);
            this.logger.all(`🎉 Sync complete.`);
        } catch (error: any) {
            this.logger.all(`⚠️ Sync interrupted due to an error: ${error.message}`);
            await this.updateStateFile(this.localPath, this.stateName, diffs); // Uložíme aktuální stav
            throw error;
        }
    }
}
