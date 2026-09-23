
require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { Transform, PassThrough } = require('stream');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType
} = require('@discordjs/voice');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// ------ Config ------
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const AIRPLAY_NAME = process.env.AIRPLAY_NAME || 'Discord AirPlay';
const AIRPLAY_PORT = Number(process.env.AIRPLAY_PORT) || 7001;
const DASHBOARD_HOST =
    process.env.DASHBOARD_HOST || '127.0.0.1';
const DASHBOARD_PORT =
    Number(process.env.DASHBOARD_PORT) || 8787;
const PIPE_PATH =
    process.env.AIRPLAY_PIPE || '/tmp/airplay_pipe';

if (!BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN is missing from .env');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let connection = null;
let player = null;
let ffmpeg = null;
let fifoFd = null;

let currentTrack = null;
let airplaySessionActive = false;
let metadataSocket = null;

let rustReceiver = null;

function startRustReceiver() {
    if (rustReceiver) {
        return;
    }

    const RUST_BUILD = process.env.RUST_BUILD || 'debug';

    const receiverPath = path.join(
        __dirname,
        'openairplay1',
        'target',
        RUST_BUILD,
        'openairplay1-receiver'
    );

    console.log('Starting AirPlay receiver...');

    rustReceiver = spawn(receiverPath, [
        '--name',
        AIRPLAY_NAME,
        '--port',
        String(AIRPLAY_PORT),
        '--dashboard-listen',
        `${DASHBOARD_HOST}:${DASHBOARD_PORT}`
    ]);

    rustReceiver.stdout.on('data', (data) => {
        process.stdout.write(`AirPlay: ${data}`);
    });

    rustReceiver.stderr.on('data', (data) => {
        process.stderr.write(`AirPlay: ${data}`);
    });

    rustReceiver.on('error', (error) => {
        console.error('AirPlay receiver error:', error);
    });

    rustReceiver.on('close', (code, signal) => {
        console.log(
            `AirPlay receiver closed. code=${code}, signal=${signal}`
        );

        rustReceiver = null;
    });
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log('Type "!join" in any server channel to bring the AirPlay bot in.');

    startRustReceiver();

    setTimeout(connectToAirplayMetadata, 1000);
});

const FFMPEG_PATH = process.env.FFMPEG_PATH;

if (!FFMPEG_PATH) {
    console.error('FFMPEG_PATH is missing from .env');
    process.exit(1);
}

function connectToAirplayMetadata() {
    if (metadataSocket) {
        return;
    }

    console.log('Connecting to AirPlay metadata...');

    metadataSocket = new WebSocket(
        `ws://${DASHBOARD_HOST}:${DASHBOARD_PORT}`
    );

    metadataSocket.on('open', () => {
        console.log('Connected to AirPlay metadata.');
    });

    metadataSocket.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            if (message.type !== 'artwork') {
                console.log('AirPlay metadata:', message);
            }

            if (message.type === 'metadata') {
                currentTrack = {
                    title: message.title,
                    artist: message.artist,
                    album: message.album
                };
            
                updateBotStatus();
                updateBotNickname();
            }

            if (message.type === 'session_started') {
                airplaySessionActive = true;
                updateBotStatus();
            }

            if (message.type === 'session_ended') {
                airplaySessionActive = false;
                currentTrack = null;
                updateBotStatus();
                updateBotNickname();
            }
        } catch (error) {
            console.error('Invalid AirPlay metadata message:', error);
        }
    });

    metadataSocket.on('error', (error) => {
        console.error('AirPlay metadata connection error:', error);
    });

    metadataSocket.on('close', () => {
        console.log('AirPlay metadata disconnected.');
        metadataSocket = null;

        setTimeout(connectToAirplayMetadata, 5000);
    });
}

function updateBotStatus() {
    if (!client.user) {
        return;
    }

    if (!airplaySessionActive || !currentTrack) {
        client.user.setPresence({
            activities: [
                {
                    name: 'Waiting for AirPlay',
                    type: 2
                }
            ],
            status: 'online'
        });
        return;
    }

    const artist = currentTrack.artist || 'Unknown artist';
    const title = currentTrack.title || 'Unknown song';

    client.user.setPresence({
        activities: [
            {
                name: `${title} — ${artist}`,
                type: 2
            }
        ],
        status: 'online'
    });
}

function startAudioStream() {
    if (ffmpeg) {
        console.log('FFmpeg is already running.');
        return;
    }

    if (!fifoFd) {
        fifoFd = fs.openSync(PIPE_PATH, 'r+');
        console.log('FIFO kept open.');
    }

    console.log('Starting FFmpeg audio stream...');

    ffmpeg = spawn(FFMPEG_PATH, [
        '-f', 's16le',
        '-ar', '44100',
        '-ac', '2',
        '-i', PIPE_PATH,
        '-ar', '48000',
        '-f', 's16le',
        'pipe:1'
    ]);

    const currentFfmpeg = ffmpeg;

    const FRAME_SIZE = 3840;

    // Keep a small amount of audio buffered so tiny timing variations
    // in FFmpeg/Node do not turn into audible skips.
    const TARGET_BUFFER = FRAME_SIZE * 10; // 500 ms

    let audioBuffer = Buffer.alloc(0);
    let started = false;

    const discordSource = new PassThrough();

    currentFfmpeg.stdout.on('data', (chunk) => {
        const wasEmpty = audioBuffer.length === 0;

        audioBuffer = Buffer.concat([audioBuffer, chunk]);

        // If AirPlay was paused and audio has just started arriving again,
        // restart the frame clock from this moment instead of trying to
        // catch up to deadlines that occurred during the pause.
        if (started && wasEmpty) {
            nextFrameTime = process.hrtime.bigint();
        }

        if (!started && audioBuffer.length >= TARGET_BUFFER) {
            started = true;
            nextFrameTime = process.hrtime.bigint();
        }
    });



    function feedFrames() {
        while (audioBuffer.length >= FRAME_SIZE) {
            const frame = audioBuffer.subarray(0, FRAME_SIZE);
            audioBuffer = audioBuffer.subarray(FRAME_SIZE);

            if (!discordSource.write(frame)) {
                return;
            }
        }
    }

    discordSource.on('drain', () => {
        feedFrames();
    });


    let nextFrameTime = null;
    let schedulerActive = false;

    function scheduleNextFrame() {
    if (!schedulerActive) {
        return;
    }

    const now = process.hrtime.bigint();

    if (nextFrameTime === null) {
        nextFrameTime = now;
    }

    // If the scheduler fell behind, don't try to "catch up"
    // by sending multiple frames immediately. That would make
    // the audio play too fast and can cause audible skips.
    if (now > nextFrameTime + 20000000n) {
        nextFrameTime = now;
    }

    const delayNs = nextFrameTime - now;
    const delayMs = Number(delayNs > 0n ? delayNs / 1000000n : 0n);

    setTimeout(() => {
        if (!schedulerActive) {
            return;
        }

        if (audioBuffer.length >= FRAME_SIZE) {
            const frame = audioBuffer.subarray(0, FRAME_SIZE);
            audioBuffer = audioBuffer.subarray(FRAME_SIZE);
            discordSource.write(frame);
        } else {
            discordSource.write(Buffer.alloc(FRAME_SIZE));
        }

        nextFrameTime += 20000000n;
        scheduleNextFrame();
    }, delayMs);
}
schedulerActive = true;
scheduleNextFrame();

    const resource = createAudioResource(discordSource, {
        inputType: StreamType.Raw
    });

    player.play(resource);

    currentFfmpeg.stderr.on('data', (data) => {
        process.stdout.write(`FFmpeg: ${data}`);
    });

    currentFfmpeg.on('error', (err) => {
        console.error('FFmpeg Error:', err);
    });

    currentFfmpeg.stdout.on('end', () => {
        console.log('FFmpeg stdout ended.');
    });

    currentFfmpeg.on('close', (code, signal) => {
        console.log(`FFmpeg closed. code=${code}, signal=${signal}`);

        schedulerActive = false;
        discordSource.end();

        if (ffmpeg === currentFfmpeg) {
            ffmpeg = null;
        }
    });
}
async function updateBotNickname() {
    if (!client.user) {
        return;
    }

    const artist = currentTrack?.artist || 'Unknown artist';
    const title = currentTrack?.title || 'Nothing playing';

    // Keep the full artist name when possible, then fit the title.
    const prefix = '🎵 ';
    const separator = ' — ';

    let nickname = `${prefix}${title}${separator}${artist}`;

    if (nickname.length > 32) {
        const availableForTitle =
            32 - prefix.length - artist.length - separator.length;

        if (availableForTitle >= 5) {
            nickname =
                `${prefix}${title.slice(0, availableForTitle)}${separator}${artist}`;
        } else {
            // Artist is too long, so shorten the artist instead.
            const availableForArtist =
                32 - prefix.length - separator.length - title.length;

            if (availableForArtist >= 5) {
                    nickname =
                        `${prefix}${title}${separator}` +
                        artist.slice(0, availableForArtist);
            } else {
                // Both are long, split the available space between them.
                const remaining =
                    32 - prefix.length - separator.length;

                const artistLength = Math.floor(remaining / 2);
                const titleLength = remaining - artistLength;

                nickname =
                    `${prefix}` +
                    title.slice(0, titleLength) +
                    `${separator}` +
                    artist.slice(0, artistLength);
            }
        }
    }

    for (const guild of client.guilds.cache.values()) {
        try {
            const me = guild.members.me;

            if (me) {
                await me.setNickname(nickname);
            }
        } catch (error) {
            console.error(
                `Could not update nickname in ${guild.name}:`,
                error.message
            );
        }
    }
}

client.on('messageCreate', async (message) => {
    console.log('MESSAGE:', message.content);

    if (message.author.bot) {
        return;
    }

    if (message.content === '!nowplaying') {
        if (!airplaySessionActive || !currentTrack) {
            await message.reply('Nothing is currently playing through AirPlay.');
            return;
        }

        const artist = currentTrack.artist || 'Unknown artist';
        const title = currentTrack.title || 'Unknown song';
        const album = currentTrack.album || 'Unknown album';

        await message.reply(
            `🎵 **${title}**\n` +
            `Artist: ${artist}\n` +
            `Album: ${album}`
        );

        return;
    }
    if (message.content === '!stop') {
        if (!player) {
            await message.reply('The AirPlay stream is not running.');
            return;
        }

        player.pause();
        await message.reply('⏸️ AirPlay audio paused in Discord.');
        return;
    }

    if (message.content === '!resume') {
        if (!player) {
            await message.reply('The AirPlay stream is not running.');
            return;
        }

        if (!ffmpeg) {
            await message.reply('The AirPlay stream is not connected.');
            return;
        }

        if (player.state.status === AudioPlayerStatus.Playing) {
            await message.reply('▶️ AirPlay audio is already playing.');
            return;
        }

        player.unpause();

        await message.reply('▶️ AirPlay audio resumed in Discord.');
        return;
    }

    if (message.content !== '!join') {
        return;
    }

    const voiceChannel = message.member?.voice.channel;

    if (!voiceChannel) {
        await message.reply('You need to join a voice channel first!');
        return;
    }

    if (!connection) {
        connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator
        });

        player = createAudioPlayer();

        connection.subscribe(player);

        connection.on('stateChange', (oldState, newState) => {
            console.log(
                `Voice connection: ${oldState.status} -> ${newState.status}`
            );

            if (newState.status === 'ready' && !ffmpeg) {
                startAudioStream();
            }
        });

        player.on(AudioPlayerStatus.Playing, () => {
            console.log('Audio player is playing.');
        });

        player.on(AudioPlayerStatus.Buffering, () => {
            console.log('Audio player is buffering.');
        });

        player.on(AudioPlayerStatus.Idle, () => {
            console.log('Audio player became idle.');
        });

        player.on('error', (error) => {
            console.error('AudioPlayer error:', error);
        });
    }

    // The connection may already exist and simply be waiting to become ready.
    if (connection.state.status === 'ready' && !ffmpeg) {
        startAudioStream();
    }

    await message.reply(
        'Connected! Stream audio from your iOS/Mac device to **Discord AirPlay**.'
    );
});

client.login(BOT_TOKEN);

process.on('SIGINT', () => {
    console.log('\nShutting down Discord AirPlay...');

    if (rustReceiver) {
        console.log('Stopping AirPlay receiver...');
        rustReceiver.kill('SIGTERM');
        rustReceiver = null;
    }

    if (ffmpeg) {
        console.log('Stopping FFmpeg...');
        ffmpeg.kill('SIGTERM');
        ffmpeg = null;
    }

    if (connection) {
        console.log('Disconnecting from Discord voice...');
        connection.destroy();
        connection = null;
    }

    client.destroy();

    console.log('Discord AirPlay stopped.');
    process.exit(0);
});