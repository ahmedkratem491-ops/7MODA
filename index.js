const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    MessageFlags,
    ChannelType,
    AuditLogEvent,
    EmbedBuilder
} = require('discord.js');
const { 
    joinVoiceChannel, 
    getVoiceConnection, 
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType
} = require('@discordjs/voice');
const { GoogleGenAI } = require('@google/genai');
const { YtDlp, helpers } = require('ytdlp-nodejs');
const ffmpegPath = require('ffmpeg-static');

// --- 1. خادم HTTP لإبقاء البوت شغال على Render ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(port, () => console.log(`Server is running on port ${port}`));

// --- 2. إعداد الـ AI والبوت ومحرك تشغيل يوتيوب (yt-dlp) ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// تقدر تضيف أي عدد من مفاتيح Gemini (من مشاريع/حسابات مختلفة) لتوسيع الحصة اليومية:
// GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3 ... بدون حد أقصى، بس رقّمها بالترتيب بدون فجوة
const extraGeminiKeys = [];
for (let i = 2; process.env[`GEMINI_API_KEY_${i}`]; i++) {
    extraGeminiKeys.push(process.env[`GEMINI_API_KEY_${i}`]);
}
const GEMINI_KEYS = [GEMINI_API_KEY, ...extraGeminiKeys].filter(Boolean);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
console.log(`مفاتيح Gemini المفعّلة: ${GEMINI_KEYS.length}`);
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.7-flash';

// شخصية البوت (تقدر تغيرها من متغير البيئة BOT_PERSONA بدون ما تلمس الكود)
const BOT_PERSONA = process.env.BOT_PERSONA || `أنت عضو عادي في سيرفر ديسكورد اسمك "Report"، شاب عربي عمره حوالي 20 سنة، تسولف مع الشلة بشكل طبيعي جداً كأنك إنسان حقيقي قاعد يدردش.
طريقة كلامك:
- لهجة عربية بيضاء مكس: تخلط بشكل عفوي بين الخليجي والمصري والشامي والمغاربي حسب المزاج (مثل "شخبارك"، "ازيك"، "كيفك"، "يا زلمة"، "وش تسوي")، بدون ما تلتزم بلهجة وحدة، ومو عربي فصيح ولا رسمي أبداً.
- ردودك قصيرة مثل رسايل الشات الحقيقية: كلمة أو جملة أو جملتين بالكثير.
- لا تستخدم إيموجي إلا نادراً جداً (مرة كل كذا رسالة بالكثير)، وغالب ردودك بدون أي إيموجي نهائياً. التعبير يجي من الكلام نفسه مو من الرموز.
- تتفاعل مع كلام الشخص نفسه بشكل طبيعي: تعلّق، تمزح بذكاء، تختلف معاه أحياناً، تسأله سؤال رجعي يكمل السالفة. لا تجاوب كأنك تكتب مقال ولا كأنك تقرأ من سكريبت.
- سوالفك حلوة وذكية مو سطحية: علّق على التفاصيل اللي يقولها الشخص فعلاً، اربط كلامك بالسياق، خلي كل رد مختلف عن اللي قبله بأسلوبه.
- لا تستخدم قوائم ولا عناوين ولا نقاط ولا نص عريض، ولا تبدأ ردك بـ "بالتأكيد" أو "بالطبع" أو "أهلاً بك".
- لا تعرض مساعدة ولا تقول "كيف أقدر أساعدك"، أنت صاحبهم مو مساعد.
- لا تذكر إنك نموذج ذكاء اصطناعي ولا تذكر جوجل أو Gemini أو أي شركة، إلا لو أحد سألك بجدية وصراحة هل أنت بوت أو إنسان، فقلها بدون لف: إنك بوت ذكاء اصطناعي.
- لو ما تعرف شي، قل "ما أدري" عادي، لا تخترع معلومات.
- المزح لطيف وخفيف، بدون إساءة أو كلام جارح.`;

// إعدادات الرد التلقائي بدون منشن (تتغير من متغيرات البيئة)
const AUTOREPLY_CHANCE = parseFloat(process.env.AUTOREPLY_CHANCE || '0.5');
const AUTOREPLY_COOLDOWN_MS = parseInt(process.env.AUTOREPLY_COOLDOWN_SEC || '30', 10) * 1000;
const autoReplyCooldown = new Map();

// ميزانية يومية للردود التلقائية (سوالف البوت) عشان ما تستهلك حصة Gemini المجانية وتخلي المنشن يشتغل
const BACKGROUND_DAILY_MAX = parseInt(process.env.BACKGROUND_DAILY_MAX || ((process.env.MISTRAL_API_KEY || process.env.CEREBRAS_API_KEY || process.env.OPENROUTER_API_KEY) ? '150' : '6'), 10);
let bgDay = '';
let bgUsed = 0;
function takeBackgroundBudget() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== bgDay) { bgDay = today; bgUsed = 0; }
    if (bgUsed >= BACKGROUND_DAILY_MAX) return false;
    bgUsed++;
    return true;
}

// ردود عفوية لما كل مزودي الذكاء الاصطناعي يفشلون (بنفس أسلوب شخصية البوت)
const BUSY_REPLIES = [
    'مشغول شوي، كلمني بعد شوي 😅',
    'استنى شوي يا صاحبي، راسي مسدود الحين 😵',
    'لحظة، مشغول الحين، ارجع لي بعد شوي',
    'والله زحمة عندي الحين، جرب بعد دقايق 🙏',
    'مو قادر أرد الحين، ثواني وأرجع 😅'
];

// ذاكرة قصيرة لكل روم عشان يتذكر سياق الحوار (آخر 10 رسائل)
const chatHistory = new Map();
function pushHistory(channelId, role, text) {
    const arr = chatHistory.get(channelId) || [];
    arr.push({ role, parts: [{ text }] });
    while (arr.length > 10) arr.shift();
    chatHistory.set(channelId, arr);
}

// يجهز نسخة آمنة من سجل الحوار لكل طلب: تبدأ برسالة مستخدم وتنتهي برسالة مستخدم (شرط Gemini)
function buildContents(channelId, fallbackPrompt) {
    const snapshot = [...(chatHistory.get(channelId) || [])];
    while (snapshot.length && snapshot[0].role !== 'user') snapshot.shift();
    while (snapshot.length && snapshot[snapshot.length - 1].role !== 'user') snapshot.pop();
    return snapshot.length ? snapshot : fallbackPrompt;
}


// عميل Gemini منفصل لكل مفتاح، نبنيه مرة وحدة ونعيد استخدامه
const geminiClients = GEMINI_KEYS.map(key => new GoogleGenAI({ apiKey: key }));
let geminiKeyCursor = 0;

// يرسل طلب لـ Gemini، يدور بين كل المفاتيح المتوفرة (لو مفتاح وصل حده ينتقل للي بعده)،
// مع إعادة محاولة عند انشغال الخدمة (503) وموديل احتياطي
async function askGeminiOnly(contents) {
    if (geminiClients.length === 0) {
        const e = new Error('لا يوجد مفتاح Gemini');
        e.status = 0;
        throw e;
    }

    const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL];
    let lastError;

    for (let k = 0; k < geminiClients.length; k++) {
        const idx = (geminiKeyCursor + k) % geminiClients.length;
        const client = geminiClients[idx];

        for (const model of models) {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const result = await client.models.generateContent({
                        model,
                        contents,
                        config: { systemInstruction: BOT_PERSONA }
                    });
                    geminiKeyCursor = (idx + 1) % geminiClients.length;
                    return result;
                } catch (e) {
                    lastError = e;
                    if (e?.status === 503 && attempt === 0) {
                        await new Promise(r => setTimeout(r, 1500));
                        continue; // نعيد نفس المفتاح والموديل مرة وحدة بس
                    }
                    break; // 429 (خلصت حصة هذا المفتاح) أو خطأ دائم، جرب الموديل التالي أو المفتاح التالي
                }
            }
        }
    }
    throw lastError;
}


// --- عدة مزودين ذكاء اصطناعي مجانيين (كلهم بصيغة OpenAI). يشتغل اللي مفتاحه موجود بـ Render ---
const PROVIDERS = [
    {
        name: 'Mistral',
        key: process.env.MISTRAL_API_KEY,
        url: 'https://api.mistral.ai/v1/chat/completions',
        model: process.env.MISTRAL_MODEL || 'mistral-small-latest'
    },
    {
        name: 'Cerebras',
        key: process.env.CEREBRAS_API_KEY,
        url: 'https://api.cerebras.ai/v1/chat/completions',
        model: process.env.CEREBRAS_MODEL || 'llama-3.3-70b'
    },
    {
        name: 'OpenRouter',
        key: process.env.OPENROUTER_API_KEY,
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free'
    }
].filter(p => p.key);

console.log('مزودو الذكاء الاصطناعي المفعّلون:', PROVIDERS.map(p => p.name).join(', ') || 'لا يوجد (Gemini فقط)');

function toOpenAIMessages(contents) {
    const messages = [{ role: 'system', content: BOT_PERSONA }];
    if (typeof contents === 'string') {
        messages.push({ role: 'user', content: contents });
    } else {
        for (const turn of contents) {
            messages.push({
                role: turn.role === 'model' ? 'assistant' : 'user',
                content: turn.parts.map(p => p.text).join('')
            });
        }
    }
    return messages;
}

// يشيل وسوم التفكير الداخلي اللي تطلع من بعض النماذج (مثل <think>...</think>)
function cleanModelText(text) {
    return (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// لو اسم النموذج انحذف، نسأل المزود عن قائمة النماذج الحالية ونختار أنسب واحد للسوالف
const MODEL_PREFERENCE = [
    /llama-3\.3-70b/i, /llama-4-maverick/i, /llama-4-scout/i, /llama-3\.1-70b/i,
    /mistral-(small|medium|large)/i, /gpt-oss-120b/i, /qwen.*32b/i, /gpt-oss-20b/i, /llama-3\.1-8b/i
];
const MODEL_EXCLUDE = /whisper|guard|tts|embed|orpheus|playai|safeguard|moderation|vision|ocr|transcribe|rerank|compound/i;

async function discoverModel(provider) {
    const res = await fetch(provider.url.replace('/chat/completions', '/models'), {
        headers: { 'Authorization': `Bearer ${provider.key}` },
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`تعذر جلب قائمة نماذج ${provider.name}: ${res.status}`);
    const data = await res.json();
    const ids = (data.data || []).map(m => m.id).filter(id => id && !MODEL_EXCLUDE.test(id));
    for (const pattern of MODEL_PREFERENCE) {
        const found = ids.find(id => pattern.test(id));
        if (found) return found;
    }
    return ids[0] || null;
}

async function askOpenAICompat(provider, contents, allowDiscovery = true) {
    const res = await fetch(provider.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.key}`
        },
        body: JSON.stringify({
            model: provider.model,
            messages: toOpenAIMessages(contents),
            temperature: 0.9,
            max_tokens: 400
        }),
        signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
        if (res.status === 404 && allowDiscovery) {
            const newModel = await discoverModel(provider);
            if (newModel && newModel !== provider.model) {
                console.log(`🔄 ${provider.name}: النموذج ${provider.model} غير متاح، نستخدم ${newModel}`);
                provider.model = newModel;
                return askOpenAICompat(provider, contents, false);
            }
        }
        const err = new Error(`${provider.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    return { text: cleanModelText(data.choices?.[0]?.message?.content) };
}

// نوزع الطلبات على المزودين الاحتياطيين بالتناوب عشان ما تخلص حصة واحد بسرعة
let providerCursor = 0;

// الدالة الرئيسية: Gemini أولاً (بكل مفاتيحه)، وإذا فشلت كلها ننتقل للمزودين الاحتياطيين (Groq وغيره)
async function askAI(contents) {
    if (geminiClients.length > 0) {
        try {
            const r = await askGeminiOnly(contents);
            if (r?.text) return r;
        } catch (e) {
            console.error('كل مفاتيح Gemini فشلت، نجرب المزودين الاحتياطيين:', e.message);
        }
    }

    const count = PROVIDERS.length;
    for (let i = 0; i < count; i++) {
        const provider = PROVIDERS[(providerCursor + i) % count];
        try {
            const r = await askOpenAICompat(provider, contents);
            if (r.text) {
                providerCursor = (providerCursor + i + 1) % count;
                return r;
            }
        } catch (e) {
            console.error(`${provider.name} فشل، نجرب اللي بعده:`, e.message);
        }
    }

    if (geminiClients.length === 0) return askGeminiOnly(contents); // يرمي رسالة الخطأ الواضحة لو ما فيه أي مزود أصلاً
    throw new Error('كل المزودين فشلوا');
}

const ytdlp = new YtDlp();

// ضبط كوكيز يوتيوب من متغيرات البيئة (نفس محتوى ملف cookies.txt كما هو، بدون أي تحويل)
const COOKIES_PATH = path.join(__dirname, 'yt-cookies.txt');
if (process.env.YOUTUBE_COOKIE) {
    fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIE);
}
function cookieArgs() {
    return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

async function ensureYtDlpReady() {
    try {
        const installed = await ytdlp.checkInstallationAsync({ ffmpeg: true }).catch(() => false);
        if (!installed) {
            console.log('⏳ جاري تحميل yt-dlp / ffmpeg...');
            await helpers.downloadYtDlp().catch(e => console.error('فشل تحميل yt-dlp:', e.message));
            await helpers.downloadFFmpeg().catch(e => console.error('فشل تحميل ffmpeg:', e.message));
        }
    } catch (e) {
        console.error('خطأ في التحقق من تثبيت yt-dlp:', e);
    }
}

function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// يبحث عن فيديو أو يفهم رابط مباشر ويرجع بياناته الأساسية
async function resolveVideo(query) {
    const isUrl = /^https?:\/\//i.test(query);
    const target = isUrl ? query : `ytsearch1:${query}`;

    const info = await ytdlp.getInfoAsync(target, {
        rawArgs: ['--no-playlist', ...cookieArgs()]
    });

    const video = info?.entries ? info.entries[0] : info;
    if (!video) return null;

    const videoUrl = video.webpage_url || video.original_url
        || (video.id ? `https://www.youtube.com/watch?v=${video.id}` : null);
    if (!videoUrl) return null;

    return {
        title: video.title || 'بدون عنوان',
        url: videoUrl,
        duration: formatDuration(video.duration),
        thumbnail: video.thumbnail || video.thumbnails?.[video.thumbnails.length - 1]?.url
    };
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildModeration
    ]
});

// --- قواعد البيانات (تحفظ بملف JSON عشان ما تضيع عند إعادة التشغيل) ---
const DATA_FILE = './bot_data.json';

const warningsDB = new Map();
const logChannelsDB = new Map();
const autoChatSettings = new Map();
const afkVoiceChannels = new Map();
const musicQueue = new Map(); // لا يُحفظ بالملف، مؤقت بالذاكرة فقط
let autoChatInterval = null;

function saveData() {
    try {
        const data = {
            warnings: Array.from(warningsDB.entries()),
            logChannels: Array.from(logChannelsDB.entries()),
            autoChat: Array.from(autoChatSettings.entries()),
            afkVoice: Array.from(afkVoiceChannels.entries())
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('خطأ في حفظ البيانات:', e);
    }
}

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);

        (data.warnings || []).forEach(([key, value]) => warningsDB.set(key, value));
        (data.logChannels || []).forEach(([key, value]) => logChannelsDB.set(key, value));
        (data.autoChat || []).forEach(([key, value]) => autoChatSettings.set(key, value));
        (data.afkVoice || []).forEach(([key, value]) => afkVoiceChannels.set(key, value));

        console.log('✅ تم تحميل البيانات المحفوظة بنجاح.');
    } catch (e) {
        console.error('خطأ في تحميل البيانات:', e);
    }
}

const TOKEN = process.env.DISCORD_TOKEN || '';

function parseDuration(durationStr) {
    if (!durationStr) return null;
    const regex = /^(\d+)([mMhHdD])$/;
    const match = durationStr.match(regex);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

// دالة الاتصال وروم الـ AFK 24/7
function connectToAfkVoice(guild, channelId) {
    try {
        const connection = joinVoiceChannel({
            channelId: channelId,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: true
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    new Promise(resolve => connection.on(VoiceConnectionStatus.Signalling, resolve)),
                    new Promise(resolve => connection.on(VoiceConnectionStatus.Connecting, resolve)),
                ]);
            } catch (e) {
                setTimeout(() => connectToAfkVoice(guild, channelId), 5000);
            }
        });
    } catch (e) {
        console.error('خطأ في الاتصال بالروم الصوتي:', e);
    }
}

// --- 3. قائمة أوامر السلاش ---
const commands = [
    new SlashCommandBuilder()
        .setName('log')
        .setDescription('تحديد قناة لإرسال سجلات اللوغ إليها')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(opt => 
            opt.setName('channel')
                .setDescription('اختر قناة اللوغ')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('autochat')
        .setDescription('تفعيل أو إيقاف سوالف البوت التلقائية (يدخل بالحوار ويفتح مواضيع)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(opt =>
            opt.setName('status')
                .setDescription('الحالة')
                .setRequired(true)
                .addChoices(
                    { name: 'تفعيل (ON)', value: 'on' },
                    { name: 'إيقاف (OFF)', value: 'off' }
                )
        )
        .addChannelOption(opt =>
            opt.setName('channel')
                .setDescription('القناة المراد الدردشة فيها (مطلوبة عند التفعيل)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('afkvoice')
        .setDescription('جعل البوت متواجد في روم صوتي معين 24/7 بدون خروج')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(opt =>
            opt.setName('action')
                .setDescription('الإجراء')
                .setRequired(true)
                .addChoices(
                    { name: 'دخول ورابط القناة (Join)', value: 'join' },
                    { name: 'خروج (Leave)', value: 'leave' }
                )
        )
        .addChannelOption(opt =>
            opt.setName('channel')
                .setDescription('الروم الصوتي (مطلوب عند الدخول)')
                .addChannelTypes(ChannelType.GuildVoice)
                .setRequired(false)
        ),

    // --- أوامر الموسيقى ---
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('تشغيل أي أغنية أو فيديو من يوتيوب')
        .addStringOption(opt => 
            opt.setName('query')
                .setDescription('اسم الأغنية أو رابط الفيديو من يوتيوب')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('تخطي الأغنية أو المقطع الحالي'),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('إيقاف التشغيل وتفريغ القائمة وإخراج البوت'),

    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('إيقاف الأغنية الحالية مؤقتاً'),

    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('استئناف تشغيل الأغنية بعد الإيقاف المؤقت'),

    new SlashCommandBuilder()
        .setName('loop')
        .setDescription('تكرار الأغنية الحالية أو كل القائمة')
        .addStringOption(opt =>
            opt.setName('mode')
                .setDescription('وضع التكرار')
                .setRequired(true)
                .addChoices(
                    { name: 'إيقاف التكرار', value: 'off' },
                    { name: 'تكرار الأغنية الحالية', value: 'song' },
                    { name: 'تكرار القائمة كاملة', value: 'queue' }
                )
        ),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('عرض قائمة التشغيل الحالية'),

    new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('عرض الأغنية الشغالة حالياً'),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('عرض كل أوامر البوت'),

    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('تحذير عضو وتسجيل التحذير فقط دون تايم أوت')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('سبب التحذير').setRequired(false)),

    new SlashCommandBuilder()
        .setName('history')
        .setDescription('عرض سجل تحذيرات عضو')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true)),

    new SlashCommandBuilder()
        .setName('unwarn')
        .setDescription('إلغاء تحذير معّين لعضو برقم التحذير')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
        .addIntegerOption(opt => opt.setName('warn_id').setDescription('رقم التحذير').setRequired(true)),

    new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('إعطاء تايم أوت لعضو')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('duration').setDescription('المدة (10m / 2h / 1d)').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('السبب').setRequired(false)),

    new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription('إزالة التايم أوت عن عضو')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true)),

    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('طرد عضو من السيرفر')
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المراد طرده').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('سبب الطرد').setRequired(false)),

    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('حظر عضو نهائياً من السيرفر')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المراد حظره').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('سبب الحظر').setRequired(false)),

    new SlashCommandBuilder()
        .setName('unban')
        .setDescription('فك الحظر عن عضو باستخدام ID')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addStringOption(opt => opt.setName('user_id').setDescription('آيدي العضو المحظور').setRequired(true))
].map(cmd => cmd.toJSON());

// --- 4. تسجيل الأوامر والدردشة التلقائية والاتصال التلقائي بالرومات ---
client.once('clientReady', async () => {
    console.log(`✅ تم تشغيل البوت بنجاح باسم: ${client.user.tag}`);
    await ensureYtDlpReady();
    const rest = new REST({ version: '10' }).setToken(TOKEN || client.token);
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('✅ تم تسجيل جميع أوامر السلاش بنجاح!');
    } catch (error) {
        console.error('خطأ أثناء تسجيل الأوامر:', error);
    }

    // إعادة الاتصال التلقائي برومات الـ AFK بعد إعادة تشغيل البوت
    for (const [guildId, channelId] of afkVoiceChannels.entries()) {
        try {
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            if (guild) connectToAfkVoice(guild, channelId);
        } catch (e) {
            console.error('خطأ في إعادة الاتصال بروم AFK:', e);
        }
    }

    if (!autoChatInterval) {
        autoChatInterval = setInterval(async () => {
            for (const [guildId, config] of autoChatSettings.entries()) {
                if (!config.enabled || !config.channelId) continue;
                if (!takeBackgroundBudget()) continue;
                try {
                    const guild = await client.guilds.fetch(guildId).catch(() => null);
                    if (!guild) continue;
                    const channel = await guild.channels.fetch(config.channelId).catch(() => null);
                    if (!channel) continue;

                    // نقرأ آخر رسائل الروم عشان يعلّق على الحوار الحالي بدل ما يرمي كلام عشوائي
                    const recent = await channel.messages.fetch({ limit: 12 }).catch(() => null);
                    const transcript = recent
                        ? [...recent.values()].reverse()
                            .filter(m => m.content)
                            .map(m => `${m.author.username}: ${m.content}`)
                            .join('\n')
                        : '';

                    const prompt = transcript
                        ? `هذي آخر رسائل الروم:\n${transcript}\n\nاكتب مداخلة قصيرة وطبيعية تعلّق فيها على الكلام أو تفتح موضوع جانبي مرتبط فيه، كأنك واحد من الشلة.`
                        : 'الروم هادي. افتح موضوع سوالف خفيف ومسلي بجملة أو جملتين.';

                    const response = await askAI(prompt);
                    await channel.send(response.text);
                } catch (e) {
                    console.error('خطأ في الـ Auto-Chat:', e);
                }
            }
        }, parseInt(process.env.AUTOCHAT_INTERVAL_MIN || '180', 10) * 60 * 1000);
    }
});

async function getLogChannel(guild) {
    const channelId = logChannelsDB.get(guild.id);
    if (!channelId) return null;
    return await guild.channels.fetch(channelId).catch(() => null);
}

// --- 5. تنفيذ الأوامر ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guild } = interaction;
    const logChannel = await getLogChannel(guild);

    if (commandName === 'log') {
        const selectedChannel = options.getChannel('channel');
        logChannelsDB.set(guild.id, selectedChannel.id);
        saveData();

        const embed = new EmbedBuilder()
            .setTitle('⚙️ Log Channel Set')
            .setDescription(`Log channel updated to ${selectedChannel}`)
            .setColor(0x00FF7F)
            .setTimestamp();

        await selectedChannel.send({ embeds: [embed] });
        return interaction.reply({ content: `✅ تم ضبط روم اللوغ بنجاح على ${selectedChannel}.`, flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'autochat') {
        const status = options.getString('status');
        const channel = options.getChannel('channel');

        if (status === 'on') {
            if (!channel) {
                return interaction.reply({ content: '❌ يجب اختيار القناة النصية المراد التحدث فيها عند التفعيل!', flags: MessageFlags.Ephemeral });
            }
            autoChatSettings.set(guild.id, { enabled: true, channelId: channel.id });
            saveData();
            return interaction.reply({ content: `✅ تم تفعيل الدردشة التلقائية كل 30 دقيقة في ${channel}.`, flags: MessageFlags.Ephemeral });
        } else {
            autoChatSettings.set(guild.id, { enabled: false, channelId: null });
            saveData();
            return interaction.reply({ content: `🛑 تم إيقاف الدردشة التلقائية.`, flags: MessageFlags.Ephemeral });
        }
    }

    if (commandName === 'afkvoice') {
        const action = options.getString('action');
        const channel = options.getChannel('channel');

        if (action === 'join') {
            if (!channel) {
                return interaction.reply({ content: '❌ يجب تحديد القناة الصوتية المراد البقاء فيها!', flags: MessageFlags.Ephemeral });
            }
            afkVoiceChannels.set(guild.id, channel.id);
            saveData();
            connectToAfkVoice(guild, channel.id);
            return interaction.reply({ content: `🎙️✅ تم دخول الروم الصوتي ${channel} وسيظل البوت متواجداً فيه 24/7.`, flags: MessageFlags.Ephemeral });
        } else {
            const connection = getVoiceConnection(guild.id);
            if (connection) connection.destroy();
            afkVoiceChannels.delete(guild.id);
            saveData();
            return interaction.reply({ content: `🔴 تم خروج البوت من الروم الصوتي وتفكيك التواجد الدائم.`, flags: MessageFlags.Ephemeral });
        }
    }

    // --- معالجة أمر التشغيل /play ---
    if (commandName === 'play') {
        const query = options.getString('query');
        const voiceChannel = interaction.member.voice?.channel;

        if (!voiceChannel) {
            return interaction.reply({ content: '❌ يجب أن تكون متواجداً في روم صوتي أولاً!', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        try {
            const video = await resolveVideo(query);
            if (!video) {
                return interaction.editReply('❌ لم يتم العثور على أي نتائج لهذا البحث في يوتيوب.');
            }

            const song = {
                title: video.title,
                url: video.url,
                duration: video.duration,
                thumbnail: video.thumbnail,
                requestedBy: interaction.user.tag
            };

            let serverQueue = musicQueue.get(guild.id);

            if (!serverQueue) {
                const queueConstruct = {
                    textChannel: interaction.channel,
                    voiceChannel: voiceChannel,
                    connection: null,
                    player: createAudioPlayer({
                        behaviors: { noSubscriber: NoSubscriberBehavior.Play }
                    }),
                    resource: null,
                    songs: [],
                    loop: 'off', // off | song | queue
                    playing: true
                };

                musicQueue.set(guild.id, queueConstruct);
                queueConstruct.songs.push(song);

                try {
                    const connection = joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: guild.id,
                        adapterCreator: guild.voiceAdapterCreator,
                        selfDeaf: false,
                        selfMute: false
                    });

                    queueConstruct.connection = connection;
                    connection.subscribe(queueConstruct.player);

                    queueConstruct.player.on(AudioPlayerStatus.Idle, () => {
                        const finished = queueConstruct.songs[0];
                        if (queueConstruct.loop === 'song' && finished) {
                            // نفس الأغنية تعاد بدون حذفها من المقدمة
                            playSong(guild, finished);
                            return;
                        }
                        const justPlayed = queueConstruct.songs.shift();
                        if (queueConstruct.loop === 'queue' && justPlayed) {
                            queueConstruct.songs.push(justPlayed);
                        }
                        playSong(guild, queueConstruct.songs[0]);
                    });

                    queueConstruct.player.on('error', error => {
                        console.error('حدث خطأ في التشغيل الصوتي:', error.message);
                        queueConstruct.songs.shift();
                        playSong(guild, queueConstruct.songs[0]);
                    });

                    playSong(guild, queueConstruct.songs[0]);

                    const embed = new EmbedBuilder()
                        .setTitle('🎵 جاري التشغيل')
                        .setDescription(`[${song.title}](${song.url})`)
                        .addFields(
                            { name: 'المدة', value: song.duration || 'غير معروف', inline: true },
                            { name: 'القناة الصوتية', value: `${voiceChannel}`, inline: true },
                            { name: 'طلب بواسطة', value: song.requestedBy, inline: true }
                        )
                        .setThumbnail(song.thumbnail)
                        .setColor(0x1DB954);

                    await interaction.editReply({ embeds: [embed] });
                } catch (err) {
                    console.error(err);
                    musicQueue.delete(guild.id);
                    return interaction.editReply('❌ تعذر الاتصال بالروم الصوتي!');
                }
            } else {
                serverQueue.songs.push(song);
                const embed = new EmbedBuilder()
                    .setTitle('🎶 تم الإضافة إلى قائمة الانتظار')
                    .setDescription(`[${song.title}](${song.url})`)
                    .addFields(
                        { name: 'المدة', value: song.duration || 'غير معروف', inline: true },
                        { name: 'الترتيب في القائمة', value: `#${serverQueue.songs.length}`, inline: true }
                    )
                    .setThumbnail(song.thumbnail)
                    .setColor(0xF1C40F);

                return interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            console.error(error);
            await interaction.editReply('❌ حدث خطأ أثناء جلب الفيديو من يوتيوب.');
        }
    }

    if (commandName === 'skip') {
        const serverQueue = musicQueue.get(guild.id);
        if (!serverQueue) return interaction.reply({ content: '❌ لا يوجد شيء يشتغل حالياً للتخطي!', flags: MessageFlags.Ephemeral });
        if (!interaction.member.voice?.channel) return interaction.reply({ content: '❌ يجب أن تكون في الروم الصوتي لاستخدام هذا الأمر!', flags: MessageFlags.Ephemeral });

        // نلغي وضع تكرار الأغنية مؤقتاً عشان السكيب يشتغل صح
        if (serverQueue.loop === 'song') serverQueue.loop = 'off';
        killActiveAudio(serverQueue);
        serverQueue.player.stop();
        return interaction.reply('⏭️ تم تخطي المقطع الحالي.');
    }

    if (commandName === 'stop') {
        const serverQueue = musicQueue.get(guild.id);
        if (!serverQueue) return interaction.reply({ content: '❌ البوت لا يشغل أي شيء حالياً!', flags: MessageFlags.Ephemeral });

        serverQueue.songs = [];
        serverQueue.loop = 'off';
        killActiveAudio(serverQueue);
        serverQueue.player.stop();
        if (serverQueue.connection) serverQueue.connection.destroy();
        musicQueue.delete(guild.id);

        return interaction.reply('⏹️ تم إيقاف التشغيل وتفريغ القائمة وإخراج البوت.');
    }

    if (commandName === 'pause') {
        const serverQueue = musicQueue.get(guild.id);
        if (!serverQueue || !serverQueue.songs.length) {
            return interaction.reply({ content: '❌ لا يوجد شيء يشتغل حالياً!', flags: MessageFlags.Ephemeral });
        }
        const paused = serverQueue.player.pause();
        return interaction.reply(paused ? '⏸️ تم إيقاف التشغيل مؤقتاً.' : '❌ التشغيل متوقف بالفعل.');
    }

    if (commandName === 'resume') {
        const serverQueue = musicQueue.get(guild.id);
        if (!serverQueue || !serverQueue.songs.length) {
            return interaction.reply({ content: '❌ لا يوجد شيء يشتغل حالياً!', flags: MessageFlags.Ephemeral });
        }
        const resumed = serverQueue.player.unpause();
        return interaction.reply(resumed ? '▶️ تم استئناف التشغيل.' : '❌ التشغيل شغال بالفعل.');
    }

    if (commandName === 'loop') {
        const serverQueue = musicQueue.get(guild.id);
        const mode = options.getString('mode');
        if (!serverQueue) {
            return interaction.reply({ content: '❌ لا يوجد شيء يشتغل حالياً!', flags: MessageFlags.Ephemeral });
        }
        serverQueue.loop = mode;
        const labels = { off: 'إيقاف التكرار', song: 'تكرار الأغنية الحالية', queue: 'تكرار القائمة كاملة' };
        return interaction.reply(`🔁 تم ضبط وضع التكرار: ${labels[mode]}.`);
    }

    if (commandName === 'queue') {
        const serverQueue = musicQueue.get(guild.id);
        if (!serverQueue || !serverQueue.songs.length) {
            return interaction.reply({ content: 'ℹ️ لا يوجد قائمة تشغيل حالياً.', flags: MessageFlags.Ephemeral });
        }

        const list = serverQueue.songs
            .slice(0, 10)
            .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} [${s.title}](${s.url}) — ${s.duration || '?'}`)
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle('📋 قائمة التشغيل الحالية')
            .setDescription(list)
            .setFooter({ text: `الإجمالي: ${serverQueue.songs.length} مقطع | التكرار: ${serverQueue.loop}` })
            .setColor(0x3498DB);

        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'nowplaying') {
        const serverQueue = musicQueue.get(guild.id);
        const current = serverQueue?.songs?.[0];
        if (!current) {
            return interaction.reply({ content: 'ℹ️ لا يوجد شيء يشتغل حالياً.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setTitle('🎧 الآن يعزف')
            .setDescription(`[${current.title}](${current.url})`)
            .addFields(
                { name: 'المدة', value: current.duration || 'غير معروف', inline: true },
                { name: 'التكرار', value: serverQueue.loop, inline: true }
            )
            .setThumbnail(current.thumbnail)
            .setColor(0x1DB954);

        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('📖 قائمة أوامر البوت')
            .setColor(0x5865F2)
            .addFields(
                { name: '🎵 الموسيقى', value: '`/play` `/skip` `/stop` `/pause` `/resume` `/loop` `/queue` `/nowplaying`' },
                { name: '🛡️ الإدارة', value: '`/warn` `/history` `/unwarn` `/timeout` `/untimeout` `/kick` `/ban` `/unban`' },
                { name: '⚙️ الإعدادات', value: '`/log` `/autochat` `/afkvoice`' }
            )
            .setFooter({ text: 'اذكر البوت بأي رسالة عشان يرد عليك بالذكاء الاصطناعي' });

        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'warn') {
        const targetUser = options.getUser('user');
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';

        if (!warningsDB.has(targetUser.id)) warningsDB.set(targetUser.id, []);
        const userWarns = warningsDB.get(targetUser.id);
        const warnId = userWarns.length + 1;

        const formattedDate = new Date().toLocaleString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });

        userWarns.push({ id: warnId, reason, moderator: interaction.user.tag, date: formattedDate });
        saveData();

        try { await targetUser.send(`⚠️ **تنبيه:** تلقيت تحذيراً رقم (#${warnId}) في سيرفر **${guild.name}**\n**السبب:** ${reason}`); } catch (e) {}

        if (logChannel) {
            const embed = new EmbedBuilder()
                .setTitle('⚠️ Member Warned')
                .setColor(0xFFA500)
                .addFields(
                    { name: 'User', value: `${targetUser} (\`${targetUser.id}\`)`, inline: true },
                    { name: 'Moderator', value: `${interaction.user} (\`${interaction.user.id}\`)`, inline: true },
                    { name: 'Warn ID', value: `#${warnId}`, inline: true },
                    { name: 'Reason', value: reason }
                )
                .setTimestamp();
            await logChannel.send({ embeds: [embed] });
        }
        await interaction.reply({ content: `✅ تم تحذير ${targetUser.tag} برقم (#${warnId}).`, flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'history') {
        const targetUser = options.getUser('user');
        const userWarns = warningsDB.get(targetUser.id) || [];

        if (userWarns.length === 0) {
            return interaction.reply({ content: `ℹ️ العضو ${targetUser.tag} ليس لديه أي تحذيرات.`, flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setTitle(`📜 Warning History - ${targetUser.tag}`)
            .setColor(0x3498DB)
            .setThumbnail(targetUser.displayAvatarURL())
            .setFooter({ text: `Total Warnings: ${userWarns.length}` })
            .setTimestamp();

        userWarns.forEach(w => {
            embed.addFields({
                name: `Warn #${w.id} -${w.date}`,
                value: `**Reason:** ${w.reason}\n**By:** ${w.moderator}`
            });
        });

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'unwarn') {
        const targetUser = options.getUser('user');
        const warnId = options.getInteger('warn_id');
        let userWarns = warningsDB.get(targetUser.id) || [];
        const index = userWarns.findIndex(w => w.id === warnId);

        if (index === -1) {
            return interaction.reply({ content: `❌ لم يتم العثور على تحذير برقم (#${warnId}).`, flags: MessageFlags.Ephemeral });
        }

        userWarns.splice(index, 1);
        saveData();
        if (logChannel) {
            const embed = new EmbedBuilder()
                .setTitle('🟢 Warning Removed')
                .setColor(0x2ECC71)
                .addFields(
                    { name: 'User', value: `${targetUser} (\`${targetUser.id}\`)`, inline: true },
                    { name: 'Moderator', value: `${interaction.user}`, inline: true },
                    { name: 'Removed Warn ID', value: `#${warnId}`, inline: true }
                )
                .setTimestamp();
            await logChannel.send({ embeds: [embed] });
        }
        await interaction.reply({ content: `✅ تم إلغاء التحذير (#${warnId}) عن ${targetUser.tag}.`, flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'timeout') {
        const targetUser = options.getUser('user');
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        const durationInput = options.getString('duration');
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';

        if (!member) return interaction.reply({ content: '❌ لم يتم العثور على العضو.', flags: MessageFlags.Ephemeral });

        const ms = parseDuration(durationInput);
        if (!ms) {
            return interaction.reply({ content: '❌ صيغة الوقت غير صحيحة! استخدم: `10m` للدقائق، `2h` للساعات، `1d` للأيام.', flags: MessageFlags.Ephemeral });
        }

        try {
            await member.timeout(ms, reason);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('🔇 Member Muted (Timeout)')
                    .setColor(0xE67E22)
                    .addFields(
                        { name: 'User', value: `${targetUser} (\`${targetUser.id}\`)`, inline: true },
                        { name: 'Moderator', value: `${interaction.user}`, inline: true },
                        { name: 'Duration', value: durationInput, inline: true },
                        { name: 'Reason', value: reason }
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] });
            }
            await interaction.reply({ content: `✅ تم تطبيق تايم أوت على ${targetUser.tag} لمدة ${durationInput}.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل تطبيق التايم أوت!', flags: MessageFlags.Ephemeral });
        }
    }

    if (commandName === 'untimeout') {
        const targetUser = options.getUser('user');
        const member = await guild.members.fetch(targetUser.id).catch(() => null);

        if (!member) return interaction.reply({ content: '❌ لم يتم العثور على العضو.', flags: MessageFlags.Ephemeral });

        try {
            await member.timeout(null);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('🔊 Member Unmuted')
                    .setColor(0x2ECC71)
                    .addFields(
                        { name: 'User', value: `${targetUser} (\`${targetUser.id}\`)`, inline: true },
                        { name: 'Moderator', value: `${interaction.user}`, inline: true }
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] });
            }
            await interaction.reply({ content: `✅ تم إلغاء التايم أوت عن ${targetUser.tag}.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل إزالة التايم أوت!', flags: MessageFlags.Ephemeral });
        }
    }

    if (commandName === 'kick') {
        const targetUser = options.getUser('user');
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';

        if (!member) return interaction.reply({ content: '❌ لم يتم العثور على العضو.', flags: MessageFlags.Ephemeral });

        try {
            await member.kick(reason);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('👢 Member Kicked')
                    .setColor(0xE74C3C)
                    .addFields(
                        { name: 'User', value: `${targetUser.tag} (\`${targetUser.id}\`)`, inline: true },
                        { name: 'Moderator', value: `${interaction.user}`, inline: true },
                        { name: 'Reason', value: reason }
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] });
            }
            await interaction.reply({ content: `✅ تم طرد ${targetUser.tag} بنجاح.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل الطرد!', flags: MessageFlags.Ephemeral });
        }
    }

    if (commandName === 'ban') {
        const targetUser = options.getUser('user');
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';

        try {
            await guild.members.ban(targetUser.id, { reason });
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('🔨 Member Banned')
                    .setColor(0x990000)
                    .addFields(
                        { name: 'User', value: `${targetUser.tag} (\`${targetUser.id}\`)`, inline: true },
                        { name: 'Moderator', value: `${interaction.user}`, inline: true },
                        { name: 'Reason', value: reason }
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] });
            }
            await interaction.reply({ content: `✅ تم حظر ${targetUser.tag} بنجاح.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل الحظر!', flags: MessageFlags.Ephemeral });
        }
    }

    if (commandName === 'unban') {
        const userId = options.getString('user_id');

        try {
            await guild.members.unban(userId);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('🔓 Member Unbanned')
                    .setColor(0x2ECC71)
                    .addFields(
                        { name: 'User ID', value: `\`${userId}\``, inline: true },
                        { name: 'Moderator', value: `${interaction.user}`, inline: true }
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] });
            }
            await interaction.reply({ content: `✅ تم فك الحظر عن الآيدي (${userId}) بنجاح.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل فك الحظر!', flags: MessageFlags.Ephemeral });
        }
    }
});

// --- 6. الـ AI للرد على الفورمز والـ Mentions ---
client.on('messageCreate', async (message) => {
    if (message.author.id === client.user.id || !message.guild) return;

    const isFormMessage = message.embeds.some(e => e.title?.toLowerCase().includes('form') || e.title?.includes('نموذج') || e.title?.includes('تقديم')) 
                          || message.content.toLowerCase().includes('form') 
                          || message.content.includes('تم إرسال نموذج');

    if (isFormMessage) {
        try {
            await message.channel.sendTyping();
            const response = await askAI("واحد من الأعضاء توه عبّى وأرسل نموذج (فورم) بالسيرفر. اكتب له رد قصير مشجع ولطيف.");
            await message.reply(response.text);
            return;
        } catch (e) {
            console.error('خطأ في الرد على الفورم:', e);
        }
    }

    // لو الرسالة رد على رسالة من البوت، نعتبرها كأنها منشن (يكمل الحوار طبيعي)
    let isReplyToBot = false;
    if (message.reference?.messageId && !message.mentions.has(client.user.id)) {
        const ref = await message.fetchReference().catch(() => null);
        isReplyToBot = ref?.author?.id === client.user.id;
    }

    // --- دخول البوت بالسوالف من نفسه في روم الدردشة التلقائية (بدون منشن) ---
    const autoCfg = message.guild ? autoChatSettings.get(message.guild.id) : null;
    if (
        autoCfg?.enabled &&
        autoCfg.channelId === message.channel.id &&
        !message.mentions.has(client.user.id) &&
        !isReplyToBot &&
        message.content &&
        message.content.length >= 3 &&
        !message.content.startsWith('/')
    ) {
        const now = Date.now();
        const last = autoReplyCooldown.get(message.channel.id) || 0;
        if (now - last >= AUTOREPLY_COOLDOWN_MS && Math.random() < AUTOREPLY_CHANCE && takeBackgroundBudget()) {
            autoReplyCooldown.set(message.channel.id, now); // نسجل الوقت قبل الطلب عشان ما يتكرر
            try {
                const recent = await message.channel.messages.fetch({ limit: 10 }).catch(() => null);
                const transcript = recent
                    ? [...recent.values()].reverse()
                        .filter(m => m.content)
                        .map(m => `${m.author.username}: ${m.content}`)
                        .join('\n')
                    : `${message.author.username}: ${message.content}`;

                const response = await askAI(
                    `هذي آخر رسائل الروم:\n${transcript}\n\nانت واحد من الشلة وقاعد تقرا الكلام. لو عندك تعليق أو مزحة أو سؤال طبيعي يناسب الحوار الأخير، اكتبه بجملة أو جملتين. لو ما في شي يستاهل تقوله، اكتب كلمة SKIP فقط.`
                );
                const text = (response.text || '').trim();
                if (text && !/^SKIP\b/i.test(text)) {
                    await message.channel.sendTyping().catch(() => null);
                    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000)); // تأخير بسيط يحسسك إنه يكتب
                    await message.channel.send(text.slice(0, 1990));
                }
            } catch (e) {
                console.error('خطأ في الرد التلقائي:', e);
            }
        }
    }

    if (message.mentions.has(client.user.id) || isReplyToBot) {
        const prompt = message.content.replace(/<@!?\d+>/g, '').trim();
        if (!prompt) return message.reply('نعم؟ تفضل وسلني عن أي شيء!');

        try {
            await message.channel.sendTyping();
            pushHistory(message.channel.id, 'user', `${message.author.username}: ${prompt}`);
            const response = await askAI(buildContents(message.channel.id, prompt));
            const responseText = response.text;
            pushHistory(message.channel.id, 'model', responseText);

            if (responseText.length > 2000) {
                await message.reply(responseText.slice(0, 1990) + '...');
            } else {
                await message.reply(responseText);
            }
        } catch (error) {
            console.error('خطأ في الـ AI:', error);
            await message.reply(BUSY_REPLIES[Math.floor(Math.random() * BUSY_REPLIES.length)]).catch(() => null);
        }
    }
});

// --- 7. سجلات اللوغ الاحترافية ---

client.on('messageDelete', async (message) => {
    if (message.author?.bot || !message.guild) return;
    const logChannel = await getLogChannel(message.guild);
    if (!logChannel) return;

    let executor = 'Unknown / Self';
    try {
        const fetchedLogs = await message.guild.fetchAuditLogs({
            limit: 1,
            type: AuditLogEvent.MessageDelete,
        });
        const deletionLog = fetchedLogs.entries.first();
        if (deletionLog && deletionLog.target.id === message.author.id && (Date.now() - deletionLog.createdTimestamp) < 5000) {
            executor = `${deletionLog.executor.tag} (${deletionLog.executor})`;
        }
    } catch (e) {}

    const embed = new EmbedBuilder()
        .setTitle('🗑️ Message Deleted')
        .setColor(0xFF4757)
        .addFields(
            { name: 'Author', value: `${message.author.tag} (${message.author})`, inline: true },
            { name: 'Deleted By', value: executor, inline: true },
            { name: 'Channel', value: `${message.channel}`, inline: true },
            { name: 'Content', value: message.content ? `\`\`\`${message.content.slice(0, 1000)}\`\`\`` : '*[No text content or embed]*' }
        )
        .setTimestamp();

    await logChannel.send({ embeds: [embed] }).catch(() => null);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (oldMessage.author?.bot || !oldMessage.guild) return;
    if (oldMessage.content === newMessage.content) return;

    const logChannel = await getLogChannel(oldMessage.guild);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
        .setTitle('✏️ Message Edited')
        .setColor(0x70A1FF)
        .addFields(
            { name: 'Author', value: `${oldMessage.author.tag} (${oldMessage.author})`, inline: true },
            { name: 'Channel', value: `${oldMessage.channel}`, inline: true },
            { name: 'Jump to Message', value: `[Click Here](${newMessage.url})`, inline: true },
            { name: 'Before', value: oldMessage.content ? `\`\`\`${oldMessage.content.slice(0, 450)}\`\`\`` : '*[Empty]*' },
            { name: 'After', value: newMessage.content ? `\`\`\`${newMessage.content.slice(0, 450)}\`\`\`` : '*[Empty]*' }
        )
        .setTimestamp();

    await logChannel.send({ embeds: [embed] }).catch(() => null);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const logChannel = await getLogChannel(newState.guild);
    if (!logChannel) return;

    const member = newState.member;
    if (member.user.bot) return;

    const getAdminExecutor = async () => {
        try {
            const fetchedLogs = await newState.guild.fetchAuditLogs({
                limit: 1,
                type: AuditLogEvent.MemberUpdate,
            });
            const logEntry = fetchedLogs.entries.first();
            if (logEntry && logEntry.target.id === member.id && (Date.now() - logEntry.createdTimestamp) < 5000) {
                return `${logEntry.executor.tag} (${logEntry.executor})`;
            }
        } catch (e) {}
        return 'Admin / Server';
    };

    if (!oldState.serverMute && newState.serverMute) {
        const admin = await getAdminExecutor();
        const embed = new EmbedBuilder()
            .setTitle('🎙️🔇 Server Mute Added')
            .setColor(0x2F3542)
            .addFields(
                { name: 'User', value: `${member.user.tag} (${member})`, inline: true },
                { name: 'Moderator', value: admin, inline: true }
            )
            .setTimestamp();
        await logChannel.send({ embeds: [embed] });
    } else if (oldState.serverMute && !newState.serverMute) {
        const admin = await getAdminExecutor();
        const embed = new EmbedBuilder()
            .setTitle('🎙️🔊 Server Mute Removed')
            .setColor(0x2ED573)
            .addFields(
                { name: 'User', value: `${member.user.tag} (${member})`, inline: true },
                { name: 'Moderator', value: admin, inline: true }
            )
            .setTimestamp();
        await logChannel.send({ embeds: [embed] });
    }

    if (!oldState.serverDeafen && newState.serverDeafen) {
        const admin = await getAdminExecutor();
        const embed = new EmbedBuilder()
            .setTitle('🎧🔇 Server Deafen Added')
            .setColor(0x2F3542)
            .addFields(
                { name: 'User', value: `${member.user.tag} (${member})`, inline: true },
                { name: 'Moderator', value: admin, inline: true }
            )
            .setTimestamp();
        await logChannel.send({ embeds: [embed] });
    } else if (oldState.serverDeafen && !newState.serverDeafen) {
        const admin = await getAdminExecutor();
        const embed = new EmbedBuilder()
            .setTitle('🎧🔊 Server Deafen Removed')
            .setColor(0x2ED573)
            .addFields(
                { name: 'User', value: `${member.user.tag} (${member})`, inline: true },
                { name: 'Moderator', value: `${admin}`, inline: true }
            )
            .setTimestamp();
        await logChannel.send({ embeds: [embed] });
    }
});

// --- 8. دالة بث الصوت المساعد (playSong) ---
// يوقف عملية yt-dlp و ffmpeg الحالية (لو موجودة) بدون ما يطيح البوت
function killActiveAudio(serverQueue) {
    if (!serverQueue) return;
    try { serverQueue.ytdlpStream?.destroy?.(); } catch (e) {}
    try { serverQueue.ffmpegProcess?.kill?.('SIGKILL'); } catch (e) {}
    serverQueue.ytdlpStream = null;
    serverQueue.ffmpegProcess = null;
}

async function playSong(guild, song) {
    const serverQueue = musicQueue.get(guild.id);
    if (!song) {
        killActiveAudio(serverQueue);
        if (serverQueue?.connection) serverQueue.connection.destroy();
        musicQueue.delete(guild.id);
        return;
    }

    if (!song.url) {
        console.error('تخطي مقطع بدون رابط صالح:', song.title);
        serverQueue.songs.shift();
        return playSong(guild, serverQueue.songs[0]);
    }

    killActiveAudio(serverQueue);

    try {
        // نجيب الصوت بواسطة yt-dlp ونمرره لـ ffmpeg عشان يحوله لصيغة خام يقدر ديسكورد يشغلها
        const ytdlpStream = ytdlp
            .stream(song.url, {
                format: { filter: 'audioonly', quality: 'highest' },
                rawArgs: cookieArgs()
            })
            .getStream();

        const ffmpegProcess = spawn(ffmpegPath, [
            '-i', 'pipe:0',
            '-analyzeduration', '0',
            '-loglevel', '0',
            '-vn',
            '-c:a', 'libopus',
            '-b:a', '96k',
            '-ar', '48000',
            '-ac', '2',
            '-f', 'ogg',
            'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'ignore'] });

        // نتجاهل أخطاء الأنابيب (EPIPE) اللي تصير طبيعياً عند السكيب المفاجئ
        ytdlpStream.on('error', () => {});
        ffmpegProcess.stdin.on('error', () => {});
        ffmpegProcess.stdout.on('error', () => {});

        ytdlpStream.pipe(ffmpegProcess.stdin);

        serverQueue.ytdlpStream = ytdlpStream;
        serverQueue.ffmpegProcess = ffmpegProcess;

        const resource = createAudioResource(ffmpegProcess.stdout, {
            inputType: StreamType.OggOpus
        });
        serverQueue.resource = resource;

        serverQueue.player.play(resource);

        const embed = new EmbedBuilder()
            .setTitle('▶️ الآن يعزف')
            .setDescription(`[${song.title}](${song.url})`)
            .setColor(0x2ECC71);

        serverQueue.textChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error('خطأ في تشغيل المقطع:', error);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

// حفظ البيانات عند إيقاف البوت (مثلاً عند إعادة نشر على Render)
process.on('SIGINT', () => { saveData(); process.exit(0); });
process.on('SIGTERM', () => { saveData(); process.exit(0); });

loadData();
client.login(TOKEN);
