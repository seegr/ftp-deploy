import * as ftp from "basic-ftp";
import fs from "fs";
import { IFileList, IDiff, syncFileDescription, currentSyncFileVersion, IFtpDeployArgumentsWithDefaults } from "./types";
import { HashDiff } from "./HashDiff";
import { ILogger, retryRequest, ITimings, applyExcludeFilter, formatNumber } from "./utilities";
import prettyBytes from "pretty-bytes";
import { prettyError } from "./errorHandling";
import { ensureDir, FTPSyncProvider } from "./syncProvider";
import { getLocalFiles } from "./localFiles";

async function downloadFileList(client: ftp.Client, logger: ILogger, path: string): Promise<IFileList> {
    // note: originally this was using a writable stream instead of a buffer file
    // basic-ftp doesn't seam to close the connection when using steams over some ftps connections. This appears to be dependent on the ftp server
    const tempFileNameHack = ".ftp-deploy-sync-server-state-buffer-file---delete.json";

    await retryRequest(logger, async () => await client.downloadTo(tempFileNameHack, path));

    const fileAsString = fs.readFileSync(tempFileNameHack, { encoding: "utf-8" });
    const fileAsObject = JSON.parse(fileAsString) as IFileList;

    fs.unlinkSync(tempFileNameHack);

    return fileAsObject;
}

function createLocalState(localFiles: IFileList, logger: ILogger, args: IFtpDeployArgumentsWithDefaults): void {
    logger.verbose(`Creating local state at ${args["local-dir"]}${args["state-name"]}`);
    fs.writeFileSync(`${args["local-dir"]}${args["state-name"]}`, JSON.stringify(localFiles, undefined, 4), { encoding: "utf8" });
    logger.verbose("Local state created");
}

async function connect(client: ftp.Client, args: IFtpDeployArgumentsWithDefaults, logger: ILogger) {
    let secure: boolean | "implicit" = false;
    if (args.protocol === "ftps") {
        secure = true;
    } else if (args.protocol === "ftps-legacy") {
        secure = "implicit";
    }

    client.ftp.verbose = args["log-level"] === "verbose";

    const rejectUnauthorized = args.security === "strict";

    try {
        logger.verbose(`Attempting connection to ${args.server}:${args.port} via ${args.protocol}`);
        await client.access({
            host: args.server,
            user: args.username,
            password: args.password,
            port: args.port,
            secure: secure,
            secureOptions: {
                rejectUnauthorized: rejectUnauthorized
            },
        });
        logger.verbose("FTP connection successful.");
    } catch (error: any) {
        logger.all("Connection failed. Ensure the server supports the chosen protocol (FTP/FTPS).");
        logger.verbose(`Connection error: ${error.message}`);
        throw error;
    }

    if (args["log-level"] === "verbose") {
        client.trackProgress(info => {
            logger.verbose(`${info.type} progress for "${info.name}". Progress: ${info.bytes} of ${info.bytesOverall} bytes`);
        });
    }
}

export async function getServerFiles(client: ftp.Client, logger: ILogger, timings: ITimings, args: IFtpDeployArgumentsWithDefaults): Promise<IFileList> {
    try {
        await ensureDir(client, logger, timings, args["server-dir"]);

        if (args["dangerous-clean-slate"]) {
            logger.all(`----------------------------------------------------------------`);
            logger.all("🗑️ Removing all files on the server because 'dangerous-clean-slate' was set, this will make the deployment very slow...");
            if (args["dry-run"] === false) {
                await client.clearWorkingDir();
            }
            logger.all("Clear complete");

            throw new Error("dangerous-clean-slate was run");
        }

        const serverFiles = await downloadFileList(client, logger, args["state-name"]);
        logger.all(`----------------------------------------------------------------`);
        logger.all(`Last published on 📅 ${new Date(serverFiles.generatedTime).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric" })}`);

        // apply exclude options to server
        if (args.exclude.length > 0) {
            const filteredData = serverFiles.data.filter((item) => applyExcludeFilter({ path: item.name, isDirectory: () => item.type === "folder" }, args.exclude));
            serverFiles.data = filteredData;
        }

        return serverFiles;
    }
    catch (error) {
        logger.all(`----------------------------------------------------------------`);
        logger.all(`No file exists on the server "${args["server-dir"] + args["state-name"]}" - this must be your first publish! 🎉`);
        logger.all(`The first publish will take a while... but once the initial sync is done only differences are published!`);
        logger.all(`If you get this message and its NOT your first publish, something is wrong.`);

        // set the server state to nothing, because we don't know what the server state is
        return {
            description: syncFileDescription,
            version: currentSyncFileVersion,
            generatedTime: new Date().getTime(),
            data: [],
        };
    }
}

async function ensureStateFileExists(
  client: ftp.Client,
  logger: ILogger,
  timings: ITimings,
  localPath: string,
  serverPath: string,
  stateName: string
) {
    const serverStatePath = `${serverPath}${stateName}`;
    logger.all(`Ensuring state file "${serverStatePath}" exists on the server.`);

    try {
        // Check if state file exists
        const files = await client.list(serverPath);
        const stateFileExists = files.some(file => file.name === stateName);

        if (!stateFileExists) {
            logger.standard(`State file "${serverStatePath}" does not exist. Creating it...`);

            // **ZDE přidáme inicializaci prázdného state.json**
            const initialState: IFileList = {
                description: syncFileDescription,
                version: currentSyncFileVersion,
                generatedTime: new Date().getTime(),
                data: [],
            };
            createLocalState(initialState, logger, { "local-dir": localPath, "state-name": stateName } as IFtpDeployArgumentsWithDefaults);

            // Upload empty state file to the server
            const localStateFilePath = `${localPath}${stateName}`;
            await client.uploadFrom(localStateFilePath, serverStatePath);
            logger.standard(`State file "${serverStatePath}" has been created on the server.`);
        } else {
            logger.standard(`State file "${serverStatePath}" already exists.`);
        }
    } catch (error: any) {
        logger.all(`Error ensuring state file exists: ${error.message}`);
        throw error;
    }
}

export async function deploy(args: IFtpDeployArgumentsWithDefaults, logger: ILogger, timings: ITimings): Promise<void> {
    timings.start("total");

    logger.all(`----------------------------------------------------------------`);
    logger.all(`🚀 Thanks for using ftp-deploy. Let's deploy some stuff!`);
    logger.all(`Nazdárek 💩 ... (Thank you Sam!)`);
    logger.all(`----------------------------------------------------------------`);
    logger.all(`If you found this project helpful, please support it`);
    logger.all(`by giving it a ⭐ on Github --> https://github.com/SamKirkland/FTP-Deploy-Action`);
    logger.all(`or add a badge 🏷️ to your projects readme --> https://github.com/SamKirkland/FTP-Deploy-Action#badge`);
    logger.verbose(`Using the following excludes filters: ${JSON.stringify(args.exclude)}`);

    timings.start("hash");
    const localFiles = await getLocalFiles(args);
    timings.stop("hash");

    createLocalState(localFiles, logger, args);

    const client = new ftp.Client(args.timeout);
    const stateName = args["state-name"];
    const localPath = args["local-dir"];
    const serverPath = args["server-dir"];

    global.reconnect = async function () {
        timings.start("connecting");
        await connect(client, args, logger);
        timings.stop("connecting");
    };

    let totalBytesUploaded = 0;

    try {
        await global.reconnect();

        // Ensure state.json exists
        await ensureStateFileExists(client, logger, timings, localPath, serverPath, stateName);

        // Get server files
        const serverFiles = await getServerFiles(client, logger, timings, args);

        // Calculate diffs
        timings.start("logging");
        const diffTool: IDiff = new HashDiff();

        logger.standard(`----------------------------------------------------------------`);
        logger.standard(`Local Files:\t${formatNumber(localFiles.data.length)}`);
        logger.standard(`Server Files:\t${formatNumber(serverFiles.data.length)}`);
        logger.standard(`----------------------------------------------------------------`);
        logger.standard(`Calculating differences between client & server`);
        logger.standard(`----------------------------------------------------------------`);

        const diffs = diffTool.getDiffs(localFiles, serverFiles);

        diffs.upload.filter(item => item.type === "folder").map(item => {
            logger.standard(`📁 Create: ${item.name}`);
        });

        diffs.upload.filter(item => item.type === "file").map(item => {
            logger.standard(`📄 Upload: ${item.name}`);
        });

        diffs.replace.map(item => {
            logger.standard(`🔁 File replace: ${item.name}`);
        });

        diffs.delete.filter(item => item.type === "file").map(item => {
            logger.standard(`📄 Delete: ${item.name}`);
        });

        diffs.delete.filter(item => item.type === "folder").map(item => {
            logger.standard(`📁 Delete: ${item.name}`);
        });

        diffs.same.map(item => {
            if (item.type === "file") {
                logger.standard(`⚖️  File content is the same, doing nothing: ${item.name}`);
            }
        });

        timings.stop("logging");

        totalBytesUploaded = diffs.sizeUpload + diffs.sizeReplace;

        // Upload files
        timings.start("upload");
        try {
            const syncProvider = new FTPSyncProvider(
              client,
              logger,
              timings,
              localPath,
              serverPath,
              stateName,
              args["dry-run"],
              args.server, // Přidáme server
              args.username, // Přidáme username
              args.password // Přidáme password
            );
            await syncProvider.syncLocalToServer(diffs);
        } finally {
            timings.stop("upload");
        }
    } catch (error) {
        prettyError(logger, args, error);
        throw error;
    } finally {
        client.close();
        timings.stop("total");
    }

    const uploadSpeed = prettyBytes(totalBytesUploaded / (timings.getTime("upload") / 1000));

    logger.all(`----------------------------------------------------------------`);
    logger.all(`Time spent hashing: ${timings.getTimeFormatted("hash")}`);
    logger.all(`Time spent connecting to server: ${timings.getTimeFormatted("connecting")}`);
    logger.all(`Time spent deploying: ${timings.getTimeFormatted("upload")} (${uploadSpeed}/second)`);
    logger.all(`  - changing dirs: ${timings.getTimeFormatted("changingDir")}`);
    logger.all(`  - logging: ${timings.getTimeFormatted("logging")}`);
    logger.all(`----------------------------------------------------------------`);
    logger.all(`Total time: ${timings.getTimeFormatted("total")}`);
    logger.all(`----------------------------------------------------------------`);
}