#!/usr/bin/env node

/**
 * The purpose of this file is to run and install homebridge and homebridge-config-ui-x as a service
 */

process.title = 'hb-service';

import * as os from 'os';
import * as path from 'path';
import * as commander from 'commander';
import * as child_process from 'child_process';
import * as fs from 'fs-extra';
import * as tcpPortUsed from 'tcp-port-used';
import * as si from 'systeminformation';
import { Tail } from 'tail';

import { Win32Installer } from './platforms/win32';
import { LinuxInstaller } from './platforms/linux';
import { DarwinInstaller } from './platforms/darwin';

export class HomebridgeServiceHelper {
  public action: string;
  public selfPath = __filename;
  public serviceName = 'Homebridge';
  public storagePath;
  public allowRunRoot = false;
  public asUser;
  private log: fs.WriteStream;
  private homebridgeBinary: string;
  private homebridge: child_process.ChildProcessWithoutNullStreams;
  private homebridgeStopped = true;
  private homebridgeOpts = [];
  private homebridgeCustomEnv = {};
  private uiBinary: string;

  public uiPort = 8581;

  private installer: Win32Installer | LinuxInstaller | DarwinInstaller;

  get logPath(): string {
    return path.resolve(this.storagePath, 'homebridge.log');
  }

  constructor() {
    // check the node.js version
    this.nodeVersionCheck();

    // select the installer for the current platform
    switch (os.platform()) {
      case 'linux':
        this.installer = new LinuxInstaller(this);
        break;
      case 'win32':
        this.installer = new Win32Installer(this);
        break;
      case 'darwin':
        this.installer = new DarwinInstaller(this);
        break;
      default:
        this.logger(`ERROR: This command is not supported on ${os.platform()}.`);
        process.exit(1);
    }

    commander
      .allowUnknownOption()
      .arguments('<install|uninstall|start|stop|restart|rebuild|run|logs>')
      .option('-P, --plugin-path [path]', '', (p) => { process.env.UIX_CUSTOM_PLUGIN_PATH = p; this.homebridgeOpts.push('-P', p); })
      .option('-U, --user-storage-path [path]', '', (p) => this.storagePath = p)
      .option('-I, --insecure', '', () => process.env.UIX_INSECURE_MODE = '1')
      .option('-S, --service-name [service name]', 'The name of the homebridge service to install or control', (p) => this.serviceName = p)
      .option('--port [port]', 'The port to set to the Homebridge UI when installing as a service', (p) => this.uiPort = parseInt(p, 10))
      .option('--user [user]', 'The user account the Homebridge service will be installed as (Linux, macOS only)', (p) => this.asUser = p)
      .option('--allow-root', '', () => this.allowRunRoot = true)
      .option('-v, --version', 'output the version number', () => this.showVersion())
      .action((cmd) => {
        this.action = cmd;
      })
      .parse(process.argv);

    this.setEnv();

    switch (this.action) {
      case 'install': {
        this.logger(`Installing ${this.serviceName} Service`);
        this.installer.install();
        break;
      }
      case 'uninstall': {
        this.logger(`Removing ${this.serviceName} Service`);
        this.installer.uninstall();
        break;
      }
      case 'start': {
        this.logger(`Starting ${this.serviceName} Service`);
        this.installer.start();
        break;
      }
      case 'stop': {
        this.logger(`Stopping ${this.serviceName} Service`);
        this.installer.stop();
        break;
      }
      case 'restart': {
        this.logger(`Restart ${this.serviceName} Service`);
        this.installer.restart();
        break;
      }
      case 'rebuild': {
        this.logger(`Rebuilding for Node.js ${process.version}...`);
        this.installer.rebuild();
        break;
      }
      case 'run': {
        this.launch();
        break;
      }
      case 'logs': {
        this.tailLogs();
        break;
      }
      case 'before-start': {
        // this currently does nothing, but may be used in the future
        process.exit(0);
        break;
      }
      default: {
        commander.outputHelp();

        console.log('\nThe hb-service command is provided by homebridge-config-ui-x\n');
        console.log('Please provide a command:');
        console.log('    install                          install homebridge as a service');
        console.log('    uninstall                        remove the homebridge service');
        console.log('    start                            start the homebridge service');
        console.log('    stop                             stop the homebridge service');
        console.log('    restart                          restart the homebridge service');
        console.log('    rebuild                          rebuild npm modules (use after updating Node.js)');
        console.log('    run                              run homebridge daemon');
        console.log('    logs                             tails the homebridge service logs');

        process.exit(1);
      }
    }
  }

  /**
   * Logger function, log to homebridge.log file when possible
   */
  public logger(msg) {
    msg = `\x1b[37m[${new Date().toLocaleString()}]\x1b[0m ` +
      '\x1b[36m[HB Supervisor]\x1b[0m ' + msg;
    if (this.log) {
      this.log.write(msg + '\n');
    } else {
      console.log(msg);
    }
  }

  /**
   * Sets the required environment variables passed on to the child processes
   */
  private setEnv() {
    if (!this.serviceName.match(/^[a-z0-9-]+$/i)) {
      this.logger('ERROR: Service name must not contain spaces or special characters');
      process.exit(1);
    }
    if (!this.storagePath) {
      if (os.platform() === 'linux') {
        this.storagePath = path.resolve('/var/lib', this.serviceName.toLowerCase());
      } else {
        this.storagePath = path.resolve(os.homedir(), `.${this.serviceName.toLowerCase()}`);
      }
    }
    process.env.UIX_STORAGE_PATH = this.storagePath;
    process.env.UIX_CONFIG_PATH = path.resolve(this.storagePath, 'config.json');
    process.env.UIX_BASE_PATH = path.resolve(__dirname, '../../');
    process.env.UIX_SERVICE_MODE = '1';
    process.env.UIX_INSECURE_MODE = '1';
  }

  /**
   * Outputs the package version number
   */
  private showVersion() {
    const pjson = fs.readJsonSync(path.resolve(__dirname, '../../', 'package.json'));
    console.log('v' + pjson.version);
    process.exit(0);
  }

  /**
   * Opens the log file stream
   */
  private async startLog() {
    // work out the log path
    this.logger(`Logging to ${this.logPath}`);

    // redirect all stdout to the log file
    this.log = fs.createWriteStream(this.logPath, { flags: 'a' });
    process.stdout.write = process.stderr.write = this.log.write.bind(this.log);
  }

  /**
   * Trucate the log file to prevent large log files
   */
  private async truncateLog() {
    const logFile = await (await fs.readFile(this.logPath, 'utf8')).split('\n');
    if (logFile.length > 5000) {
      logFile.splice(0, (logFile.length - 5000));
    }
    await fs.writeFile(this.logPath, logFile.join('\n'), {});
  }

  /**
   * Launch script, starts homebridge and homebridge-config-ui-x
   */
  private async launch() {
    if (os.platform() !== 'win32' && process.getuid() === 0 && !this.allowRunRoot) {
      this.logger('The hb-service run command should not be executed as root.');
      this.logger('Use the --allow-root flag to force the service to run as the root user.');
      process.exit(0);
    }

    this.logger(`Homebridge Storage Path: ${this.storagePath}`);
    this.logger(`Homebridge Config Path: ${process.env.UIX_CONFIG_PATH}`);

    // start the interval to truncate the logs every two hours
    setInterval(() => {
      this.truncateLog();
    }, (1000 * 60 * 60) * 2);

    // pre-start
    try {
      // check storage path exists
      await this.storagePathCheck();

      // start logging to file
      await this.startLog();

      // verify the config
      await this.configCheck();

      // load startup options if they exist
      await this.loadHomebridgeStartupOptions();

      // work out the homebridge binary path
      const node_modules = path.resolve(process.env.UIX_BASE_PATH, '..');
      this.homebridgeBinary = path.resolve(node_modules, 'homebridge', 'bin', 'homebridge');
      this.logger(`Homebridge Path: ${this.homebridgeBinary}`);

      // get the standalone ui binary on this system
      this.uiBinary = path.resolve(process.env.UIX_BASE_PATH, 'dist', 'bin', 'standalone.js');
      this.logger(`UI Path: ${this.uiBinary}`);
    } catch (e) {
      this.logger(e.message);
      process.exit(1);
    }

    // start homebridge
    this.startExitHandler();
    this.runHomebridge();
    this.runUi();

    process.addListener('message', (event) => {
      if (event === 'clearCachedAccessories') {
        this.clearHomebridgeCachedAccessories();
      }
    });
  }

  /**
   * Handles exit event
   */
  private startExitHandler() {
    const exitHandler = () => {
      this.logger('Stopping services...');
      try {
        this.homebridge.kill();
      } catch (e) { }

      setTimeout(() => {
        try {
          this.homebridge.kill('SIGKILL');
        } catch (e) { }
        process.exit(1282);
      }, 5100);
    };

    process.on('SIGTERM', exitHandler);
    process.on('SIGINT', exitHandler);
  }

  /**
   * Starts homebridge as a child process, sending the log output to the homebridge.log
   */
  private runHomebridge() {
    this.homebridgeStopped = false;

    if (this.homebridgeOpts.length) {
      this.logger(`Starting Homebridge with extra flags: ${this.homebridgeOpts.join(' ')}`);
    }

    if (Object.keys(this.homebridgeCustomEnv).length) {
      this.logger(`Starting Homebridge with custom env: ${JSON.stringify(this.homebridgeCustomEnv)}`);
    }

    // env setup
    const env = {};
    Object.assign(env, process.env);
    Object.assign(env, this.homebridgeCustomEnv);

    // launch the homebridge process
    this.homebridge = child_process.spawn(process.execPath,
      [
        this.homebridgeBinary,
        '-I',
        '-C',
        '-Q',
        '-U',
        this.storagePath,
        ...this.homebridgeOpts,
      ],
      {
        env,
        windowsHide: true,
      },
    );

    this.logger(`Started Homebridge with PID: ${this.homebridge.pid}`);

    this.homebridge.stdout.on('data', (data) => {
      this.log.write(data);
    });

    this.homebridge.stderr.on('data', (data) => {
      this.log.write(data);
    });

    this.homebridge.on('close', (code, signal) => {
      this.handleHomebridgeClose(code, signal);
    });
  }

  /**
   * Ensures homebridge is restarted automatically if it crashed or was stopped
   * @param code
   * @param signal
   */
  private handleHomebridgeClose(code: number, signal: string) {
    this.homebridgeStopped = true;
    this.logger(`Homebridge Process Ended. Code: ${code}, Signal: ${signal}`);

    this.checkForStaleHomebridgeProcess();

    setTimeout(() => {
      this.logger('Restarting Homebridge...');
      this.runHomebridge();
    }, 5000);
  }

  /**
   * Start the user interface
   */
  private async runUi() {
    try {
      await import('../main');
    } catch (e) {
      this.logger('ERROR: The user interface threw an unhandled error');
      console.error(e);

      setTimeout(() => {
        process.exit(1);
      }, 4500);

      if (this.homebridge) {
        this.homebridge.kill();
      }
    }
  }

  /**
   * Checks the current Node.js version is > 10
   */
  private nodeVersionCheck() {
    // 64 = v10;
    if (parseInt(process.versions.modules, 10) < 64) {
      this.logger(`ERROR: Node.js v10.13.0 or greater is required. Current: ${process.version}.`);
      process.exit(1);
    }
  }

  /**
   * Prints usage information to the screen after installations
   */
  public async printPostInstallInstructions() {
    const defaultAdapter = await si.networkInterfaceDefault();
    const defaultInterface = (await si.networkInterfaces()).find(x => x.iface === defaultAdapter);

    console.log(`\nManage Homebridge by going to one of the following in your browser:\n`);

    console.log(`* http://localhost:${this.uiPort}`);

    if (defaultInterface && defaultInterface.ip4) {
      console.log(`* http://${defaultInterface.ip4}:${this.uiPort}`);
    }

    if (defaultInterface && defaultInterface.ip6) {
      console.log(`* http://[${defaultInterface.ip6}]:${this.uiPort}`);
    }

    console.log(`\nDefault Username: admin`);
    console.log(`Default Password: admin\n`);
  }

  /**
   * Checks if the port is currently in use by another process
   */
  public async portCheck() {
    const inUse = await tcpPortUsed.check(this.uiPort);
    if (inUse) {
      this.logger(`ERROR: Port ${this.uiPort} is already in use by another process on this host.`);
      this.logger(`You can specify another port using the --port flag, eg.`);
      this.logger(`hb-service ${this.action} --port 8581`);
      process.exit(1);
    }
  }

  /**
   * Ensures the storage path defined exists
   */
  public async storagePathCheck() {
    if (!await fs.pathExists(this.storagePath)) {
      this.logger(`Creating Homebridge directory: ${this.storagePath}`);
      await fs.mkdirp(this.storagePath);
      await this.chownPath(this.storagePath);
    }
  }

  /**
   * Ensures the config.json exists and is valid.
   * If the config is not valid json it will be backed up and replaced with the default.
   */
  public async configCheck() {
    if (!await fs.pathExists(process.env.UIX_CONFIG_PATH)) {
      this.logger(`Creating default config.json: ${process.env.UIX_CONFIG_PATH}`);
      return await this.createDefaultConfig();
    }

    try {
      const currentConfig = await fs.readJson(process.env.UIX_CONFIG_PATH);

      // if doing an install, make sure the ui config is set
      if (this.action === 'install') {
        if (!Array.isArray(currentConfig.platforms)) {
          currentConfig.platforms = [];
        }
        const uiConfigBlock = currentConfig.platforms.find((x) => x.platform === 'config');
        if (uiConfigBlock) {
          // correct the port
          if (uiConfigBlock.port !== this.uiPort) {
            uiConfigBlock.port = this.uiPort;
            this.logger(`WARNING: HOMEBRIDGE CONFIG UI PORT IN ${process.env.UIX_CONFIG_PATH} CHANGED TO ${this.uiPort}`);
          }
          // delete unnecessary config
          delete uiConfigBlock.restart;
          delete uiConfigBlock.sudo;
          delete uiConfigBlock.log;
        } else {
          this.logger(`Adding missing config ui block to ${process.env.UIX_CONFIG_PATH}`);
          currentConfig.platforms.push({
            name: 'Config',
            port: this.uiPort,
            platform: 'config',
          });
        }
        await fs.writeJSON(process.env.UIX_CONFIG_PATH, currentConfig, { spaces: 4 });
      }

      // ensure port is set in bridge config
      if (currentConfig.bridge && !currentConfig.bridge.port) {
        currentConfig.bridge.port = await this.generatePort();
        await fs.writeJSON(process.env.UIX_CONFIG_PATH, currentConfig, { spaces: 4 });
        this.logger(`Added missing port to Homebridge bridge block: ${currentConfig.bridge.port}`);
      }

    } catch (e) {
      const backupFile = path.resolve(this.storagePath, 'config.json.invalid.' + new Date().getTime().toString());
      this.logger(`${process.env.UIX_CONFIG_PATH} does not contain valid JSON.`);
      this.logger(`Invalid config.json file has been backed up to ${backupFile}.`);
      await fs.rename(process.env.UIX_CONFIG_PATH, backupFile);
      await this.createDefaultConfig();
    }
  }

  /**
   * Creates the default config.json
   */
  public async createDefaultConfig() {
    const username = this.generateUsername();
    const port = await this.generatePort();
    const name = 'Homebridge ' + username.substr(username.length - 5).replace(/:/g, '');
    const pin = this.generatePin();

    await fs.writeJson(process.env.UIX_CONFIG_PATH, {
      bridge: {
        name,
        username,
        port,
        pin,
      },
      accessories: [],
      platforms: [
        {
          name: 'Config',
          port: this.uiPort,
          platform: 'config',
        },
      ],
    }, { spaces: 4 });
    await this.chownPath(process.env.UIX_CONFIG_PATH);
  }

  /**
   * Generates a new random pin
   */
  private generatePin() {
    let code: string | Array<any> = Math.floor(10000000 + Math.random() * 90000000) + '';
    code = code.split('');
    code.splice(3, 0, '-');
    code.splice(6, 0, '-');
    code = code.join('');
    return code;
  }

  /**
   * Generates a new random username
   */
  private generateUsername() {
    const hexDigits = '0123456789ABCDEF';
    let username = '0E:';
    for (let i = 0; i < 5; i++) {
      username += hexDigits.charAt(Math.round(Math.random() * 15));
      username += hexDigits.charAt(Math.round(Math.random() * 15));
      if (i !== 4) {
        username += ':';
      }
    }
    return username;
  }

  /**
   * Generate a random port for Homebridge
   */
  private async generatePort() {
    const randomPort = () => Math.floor(Math.random() * (52000 - 51000 + 1) + 51000);

    let port = randomPort();
    while (await tcpPortUsed.check(this.uiPort)) {
      port = randomPort();
    }

    return port;
  }

  /**
   * Corrects the permissions on files when running the hb-service command using sudo
   */
  private async chownPath(pathToChown: fs.PathLike) {
    if (os.platform() !== 'win32' && process.getuid() === 0) {
      const { uid, gid } = await this.installer.getId();
      fs.chownSync(pathToChown, uid, gid);
    }
  }

  /**
   * Checks to see if there are stale homebridge processes running on the same port
   */
  private async checkForStaleHomebridgeProcess() {
    if (os.platform() === 'win32') {
      return;
    }
    try {
      // load the config to get the homebridge port
      const currentConfig = await fs.readJson(process.env.UIX_CONFIG_PATH);
      if (!currentConfig.bridge || !currentConfig.bridge.port) {
        return;
      }

      // check if port is still in use
      if (!await tcpPortUsed.check(currentConfig.bridge.port)) {
        return;
      }

      // find the pid of the process using the port
      const pid = this.installer.getPidOfPort(currentConfig.bridge.port);
      if (!pid) {
        return;
      }

      // kill the stale Homebridge process
      this.logger(`Found stale Homebridge process running on port ${currentConfig.bridge.port} with PID ${pid}, killing...`);
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      // do nothing
    }
  }

  /**
   * Tails the Homebridge service log and outputs the results to the console
   */
  private tailLogs() {
    if (!fs.existsSync(this.logPath)) {
      this.logger(`ERROR: Log file does not exist at expected location: ${this.logPath}`);
      process.exit(1);
    }

    const tail = new Tail(this.logPath, {
      fromBeginning: true,
      useWatchFile: true,
      fsWatchOptions: {
        interval: 200,
      },
    });

    tail.on('line', console.log);
  }

  /**
   * Returns the path of the homebridge startup settings file
   */
  get homebridgeStartupOptionsPath() {
    return path.resolve(this.storagePath, '.uix-hb-service-homebridge-startup.json');
  }

  /**
   * Get the Homebridge startup options defined in the UI
   */
  private async loadHomebridgeStartupOptions() {
    try {
      if (await fs.pathExists(this.homebridgeStartupOptionsPath)) {
        const homebridgeStartupOptions = await fs.readJson(this.homebridgeStartupOptionsPath);

        // check if debug should be enabled
        if (homebridgeStartupOptions.debugMode && !this.homebridgeOpts.includes('-D')) {
          this.homebridgeOpts.push('-D');
        }

        // check if remove orphans should be enabled
        if (homebridgeStartupOptions.removeOrphans && !this.homebridgeOpts.includes('-R')) {
          this.homebridgeOpts.push('-R');
        }

        // copy any custom env vars in
        Object.assign(this.homebridgeCustomEnv, homebridgeStartupOptions.env);
      }
    } catch (e) {
      this.logger(`Failed to load startup options ${e.message}`);
    }
  }

  /**
   * Clears the Homebridge Cached Accessories
   */
  private clearHomebridgeCachedAccessories() {
    const cachedAccessoriesPath = path.resolve(this.storagePath, 'accessories', 'cachedAccessories');

    const clearAccessoriesCache = () => {
      try {
        if (fs.existsSync(cachedAccessoriesPath)) {
          this.logger('Clearing Cached Homebridge Accessories...');
          fs.unlinkSync(cachedAccessoriesPath);
        }
      } catch (e) {
        this.logger(`ERROR: Failed to clear Homebridge Accessories Cache at ${cachedAccessoriesPath}`);
        console.error(e);
      }
    };

    if (this.homebridge && !this.homebridgeStopped) {
      this.homebridge.once('close', clearAccessoriesCache);
      this.homebridge.kill();
    } else {
      clearAccessoriesCache();
    }
  }

}

function bootstrap() {
  return new HomebridgeServiceHelper();
}

bootstrap();