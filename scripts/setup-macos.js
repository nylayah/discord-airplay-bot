const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const PROJECT_PATH = path.resolve(__dirname, '..');
const HOME = os.homedir();

console.log('Discord AirPlay macOS setup');
console.log('----------------------------');
console.log(`Project: ${PROJECT_PATH}`);
console.log(`Home:    ${HOME}`);

function findCommand(command) {
    try {
        return execFileSync('which', [command], {
            encoding: 'utf8'
        }).trim();
    } catch {
        return null;
               }
}

const nodePath = process.execPath;
const ffmpegPath = findCommand('ffmpeg');
const envPath = path.join(PROJECT_PATH, '.env');

function setEnvValue(filePath, key, value) {
    let content = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf8')
        : '';

    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');

    if (pattern.test(content)) {
        content = content.replace(pattern, line);
    } else {
        content = content.trimEnd() + (content.trimEnd() ? '\n' : '') + line + '\n';
    }

    fs.writeFileSync(filePath, content);
}
const cargoPath = findCommand('cargo');

console.log(`Node:    ${nodePath}`);

if (ffmpegPath) {
    console.log(`FFmpeg:  ${ffmpegPath}`);
    setEnvValue(envPath, 'FFMPEG_PATH', ffmpegPath);
} else {
    console.error(
        'FFmpeg was not found. Please install FFmpeg before continuing.'
    );
    process.exit(1);
}

if (cargoPath) {
    console.log(`Cargo:   ${cargoPath}`);
} else {
    console.error(
        'Cargo was not found. Please install Rust before continuing.'
    );
    process.exit(1);
}

console.log('Setup checks passed.');
console.log('Building AirPlay receiver...');

try {
    execFileSync(
        cargoPath,
        ['build', '-p', 'openairplay1-receiver'],
        {
            cwd: path.join(PROJECT_PATH, 'openairplay1'),
            stdio: 'inherit'
        }
    );

    console.log('AirPlay receiver build completed.');
} catch {
    console.error(
        'Failed to build the AirPlay receiver. Please check the Cargo output above.'
    );
    process.exit(1);
}

const templatePath = path.join(
    PROJECT_PATH,
    'com.example.discord-airplay-bot.plist.template'
);

const launchAgentsPath = path.join(
    HOME,
    'Library',
    'LaunchAgents'
);

const launchAgentLabel = 'com.discord-airplay-bot';

const launchAgentPath = path.join(
    launchAgentsPath,
    `${launchAgentLabel}.plist`
);

const logPath = '/tmp';

if (!fs.existsSync(launchAgentsPath)) {
    fs.mkdirSync(launchAgentsPath, { recursive: true });
}

let template = fs.readFileSync(templatePath, 'utf8');

template = template
    .replaceAll('__LAUNCH_AGENT_LABEL__', launchAgentLabel)
    .replaceAll('__NODE_PATH__', nodePath)
    .replaceAll('__PROJECT_PATH__', PROJECT_PATH)
    .replaceAll('__LOG_PATH__', logPath);

fs.writeFileSync(launchAgentPath, template);

const pipePath = process.env.AIRPLAY_PIPE || '/tmp/airplay_pipe';

if (!fs.existsSync(pipePath)) {
    console.log(`Creating AirPlay audio pipe: ${pipePath}`);

    try {
        execFileSync('mkfifo', [pipePath]);
    } catch {
        console.error(
            `Failed to create AirPlay audio pipe at ${pipePath}.`
        );
        process.exit(1);
    }
} else {
    console.log(`AirPlay audio pipe already exists: ${pipePath}`);
}

console.log(`LaunchAgent: ${launchAgentPath}`);
console.log('LaunchAgent plist generated.');

console.log('Loading LaunchAgent...');

const launchctlTarget = `gui/${process.getuid()}/${launchAgentLabel}`;

try {
    execFileSync(
        'launchctl',
        ['print', launchctlTarget],
        {
            stdio: 'ignore'
        }
    );

    console.log('LaunchAgent is already loaded. Restarting it...');

    execFileSync(
        'launchctl',
        ['kickstart', '-k', launchctlTarget],
        {
            stdio: 'inherit'
        }
    );

    console.log('LaunchAgent restarted successfully.');
} catch {
    console.log('LaunchAgent is not loaded. Loading it...');

    try {
        execFileSync(
            'launchctl',
            ['bootstrap', `gui/${process.getuid()}`, launchAgentPath],
            {
                stdio: 'inherit'
            }
        );

        console.log('LaunchAgent loaded successfully.');
    } catch {
        console.error(
            'Failed to load the LaunchAgent. Please check the launchctl output above.'
        );
        process.exit(1);
    }
}