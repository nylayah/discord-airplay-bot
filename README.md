# Discord AirPlay

A macOS Discord bot that turns your Mac into an AirPlay receiver and streams the received audio into a Discord voice channel.

## What it does

Discord AirPlay connects three pieces:

**AirPlay device → Mac → Discord voice channel**

Your iPhone, iPad, or other AirPlay device sees your Mac as an AirPlay speaker named **Discord AirPlay**. Audio sent to it is received by the built-in AirPlay 1 receiver, processed on the Mac, and streamed into a Discord voice channel.

The bot also exposes the currently playing song and artist through Discord.

## Requirements

* macOS
* Node.js
* Rust and Cargo
* FFmpeg
* A Discord bot application
* An AirPlay-compatible device

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/nylayah/discord-airplay-bot.git
cd discord-airplay-bot
```

### 2. Install Node dependencies

```bash
npm install
```

### 3. Configure the bot

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and add your Discord bot token:

```dotenv
DISCORD_BOT_TOKEN=your_discord_bot_token
```

Do not commit `.env` to Git. It is already included in `.gitignore`.

### 4. Run the macOS setup

```bash
npm run setup
```

The setup script will:

* Verify the required tools are available
* Build the AirPlay receiver
* Create the audio FIFO if necessary
* Generate the macOS LaunchAgent
* Start the Discord AirPlay service

### 5. Invite the bot

Invite your Discord bot to your server with permission to:

* View channels
* Send messages
* Connect to voice channels
* Speak
* Manage Nicknames

## Usage

In a Discord text channel, use:

```text
!join
```

The bot joins your current voice channel and begins forwarding AirPlay audio.

### Playback commands

```text
!nowplaying
!stop
!resume
```

* `!nowplaying` displays the current AirPlay track.
* `!stop` pauses Discord playback.
* `!resume` resumes Discord playback.

## AirPlay

Once the service is running, your Mac appears as:

**Discord AirPlay**

in the AirPlay device list.

Select it from your iPhone, iPad, or other AirPlay-compatible device.

The audio is received by the Mac and forwarded to the Discord voice channel.

## Configuration

Configuration is stored in `.env`.

Available settings include:

```dotenv
DISCORD_BOT_TOKEN=

AIRPLAY_NAME=Discord AirPlay
AIRPLAY_PORT=7001

AIRPLAY_PIPE=/tmp/airplay_pipe

DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8787

FFMPEG_PATH=
RUST_BUILD=debug
```

Most users should only need to configure `DISCORD_BOT_TOKEN`.

The setup script automatically detects the installed FFmpeg and writes its path to `.env`.

## macOS service

The setup script installs the bot as a per-user macOS LaunchAgent.

The service starts automatically when your user session loads and keeps the Discord AirPlay bot running.

To check its status:

```bash
launchctl print gui/$(id -u)/com.discord-airplay-bot
```

To stop the service:

```bash
launchctl bootout gui/$(id -u)/com.discord-airplay-bot
```

To start it again:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.discord-airplay-bot.plist
```

## Project structure

```text
discord-airplay-bot/
├── airplay/
├── openairplay1/
├── scripts/
├── .env.example
├── .gitignore
├── Dockerfile
├── index.js
├── package.json
├── shairport-sync.conf
└── com.example.discord-airplay-bot.plist.template
```

### Components

* `index.js` — Discord bot, audio pipeline, metadata handling, and AirPlay receiver management
* `openairplay1/` — AirPlay 1 receiver
* `scripts/setup-macos.js` — macOS installation and LaunchAgent setup
* `shairport-sync.conf` — Shairport Sync configuration
* `.env.example` — configuration template

## Troubleshooting

### The AirPlay device does not appear

Make sure:

1. The Discord AirPlay service is running.
2. Your AirPlay device and Mac are on the same local network.
3. macOS has not blocked the receiver.

Check the service with:

```bash
launchctl print gui/$(id -u)/com.discord-airplay-bot
```

### The bot does not join voice

Make sure the bot has permission to connect and speak in the voice channel.

### Audio is not playing

Make sure:

1. The bot is in a Discord voice channel.
2. An AirPlay device is actively sending audio to **Discord AirPlay**.
3. FFmpeg is installed.
4. The audio FIFO exists.

The default FIFO is:

```text
/tmp/airplay_pipe
```

## Security

Never commit your `.env` file or expose your Discord bot token.

If a Discord bot token is accidentally exposed, regenerate it immediately in the Discord Developer Portal.

## License

See the included `LICENSE` file.
