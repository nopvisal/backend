const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('MediaForge backend is running'));

// Write cookies if provided
if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync('./cookies.txt', process.env.YOUTUBE_COOKIES);
    console.log('Cookies file written');
} else {
    console.warn('No YOUTUBE_COOKIES – YouTube might need a proxy');
}

// ========== yt-dlp helper (with optional proxy) ==========
function ytDlp(args) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = './yt-dlp';
        const fullArgs = [
            '--js-runtime', 'node',
            '--cookies', './cookies.txt',
        ];
        // Add proxy if environment variable is set
        if (process.env.YTDLP_PROXY) {
            fullArgs.push('--proxy', process.env.YTDLP_PROXY);
        }
        fullArgs.push(...args);

        execFile(ytDlpPath, fullArgs, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout.trim());
        });
    });
}

// ========== Invidious fallback (more robust) ==========
const invidiousInstances = [
    'https://vid.puffyan.us',
    'https://invidious.snopyta.org',
    'https://yewtu.be',
    'https://invidious.fdn.fr',
    'https://invidious.nerdvpn.de',
    'https://invidious.weblibre.org',
];

async function tryInvidious(videoId) {
    for (const instance of invidiousInstances) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const resp = await fetch(`${instance}/api/v1/videos/${videoId}`, { signal: controller.signal });
            clearTimeout(timeout);
            if (!resp.ok) continue;
            const data = await resp.json();
            const format = data.formatStreams
                ?.filter(f => f.container === 'mp4' && f.audioChannels > 0)
                ?.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
            if (!format) continue;
            return {
                title: data.title,
                thumbnail: data.videoThumbnails?.[0]?.url || '',
                downloadUrl: format.url,
            };
        } catch (e) { /* instance failed, try next */ }
    }
    return null;
}

// ========== Free rotating proxy list (for yt-dlp) ==========
let proxyList = [];
let proxyIndex = 0;
async function refreshProxyList() {
    try {
        // Fetch free residential proxies (these are HTTP, not all work, but we cycle)
        const resp = await fetch('https://proxylist.geonode.com/api/proxy-list?limit=20&page=1&sort_by=lastChecked&sort_type=desc&protocols=http');
        const data = await resp.json();
        proxyList = data.data.map(p => `http://${p.ip}:${p.port}`);
        console.log(`Loaded ${proxyList.length} proxies`);
    } catch (e) {
        console.warn('Failed to refresh proxy list:', e.message);
    }
}
refreshProxyList();
setInterval(refreshProxyList, 15 * 60 * 1000); // refresh every 15 min

function getNextProxy() {
    if (proxyList.length === 0) return null;
    const proxy = proxyList[proxyIndex % proxyList.length];
    proxyIndex++;
    return proxy;
}

// ========== YouTube video info with fallback ==========
app.get('/api/youtube', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const idMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:&|$|\/|\.)/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (!idMatch) return res.status(400).json({ error: 'Invalid YouTube URL' });
    const videoId = idMatch[1];

    // 1. Try yt-dlp first (with cookies + optional proxy)
    try {
        const json = await ytDlp(['--dump-json', '--no-playlist', url]);
        const info = JSON.parse(json);
        const format = (info.formats || [])
            .filter(f => f.acodec !== 'none' && f.vcodec !== 'none')
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (!format) throw new Error('No combined format');
        const directUrl = await ytDlp(['-f', format.format_id, '-g', url]);
        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            downloadUrl: directUrl,
        });
        return;
    } catch (ytErr) {
        console.warn('yt-dlp failed:', ytErr.message);
        // try yt-dlp with a free proxy (no cookies needed sometimes)
        try {
            const proxy = getNextProxy();
            if (proxy) {
                const proxyArgs = ['--proxy', proxy, '--dump-json', '--no-playlist', url];
                const ytDlpPath = './yt-dlp';
                const json = await new Promise((resolve, reject) => {
                    execFile(ytDlpPath, proxyArgs, { maxBuffer: 20*1024*1024 }, (err, stdout, stderr) => {
                        if (err) reject(new Error(stderr));
                        else resolve(stdout.trim());
                    });
                });
                const info = JSON.parse(json);
                const format = (info.formats || [])
                    .filter(f => f.acodec !== 'none' && f.vcodec !== 'none')
                    .sort((a,b) => (b.height||0)-(a.height||0))[0];
                if (!format) throw new Error('No combined format');
                const directUrl = await new Promise((resolve, reject) => {
                    execFile(ytDlpPath, ['--proxy', proxy, '-f', format.format_id, '-g', url], { maxBuffer: 20*1024*1024 }, (err, stdout) => {
                        if (err) reject(new Error(stderr));
                        else resolve(stdout.trim());
                    });
                });
                res.json({ title: info.title, thumbnail: info.thumbnail, downloadUrl: directUrl });
                return;
            }
        } catch (proxyErr) {
            console.warn('yt-dlp with proxy failed:', proxyErr.message);
        }
    }

    // 2. Fallback to Invidious
    const invidiousResult = await tryInvidious(videoId);
    if (invidiousResult) {
        res.json(invidiousResult);
        return;
    }

    // 3. All failed
    res.status(500).json({ error: 'All YouTube extraction methods failed. Please try again later.' });
});

// ========== Other endpoints (Facebook, TikTok, proxy download) ==========
// Keep your existing /api/info, /api/download, /api/tiktok, /api/proxy-download here
// (unchanged from your current working version)