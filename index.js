const express = require('express');
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    MessageFlags,
    ChannelType,
    AuditLogEvent
} = require('discord.js');
const { 
    joinVoiceChannel, 
    getVoiceConnection, 
    VoiceConnectionStatus 
} = require('@discordjs/voice');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- 1. خادم HTTP لإبقاء البوت شغال على Render ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(port, () => console.log(`Server is running on port ${port}`));

// --- 2. إعداد الـ AI والبوت والـ Intents ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'ضع_مفتاح_الـ_API_هنا';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildModeration
    ]
});

// قواعد البيانات في الذاكرة
const warningsDB = new Map(); 
const logChannelsDB = new Map();
const autoChatSettings = new Map(); // { guildId: { enabled: boolean, channelId: string } }
const afkVoiceChannels = new Map(); // { guildId: channelId }
let autoChatInterval = null;

const TOKEN = process.env.DISCORD_TOKEN || 'ضع_التوكين_هنا';

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
                // في حال انقطع الاتصال يتم إعادة الدخول تلقائياً
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

    // أمر التحكم بالدردشة التلقائية كل 30 دقيقة
    new SlashCommandBuilder()
        .setName('autochat')
        .setDescription('تفعيل أو إيقاف الدردشة التلقائية للذكاء الاصطناعي كل 30 دقيقة')
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

    // أمر بقاء البوت 24/7 في الفويس (AFK Voice)
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

    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('تحذير عضو وتطبيق تايم أوت تلقائي عليه')
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
        .addUserOption(opt => opt.setName('user').setDescription('العضو المرادطرده').setRequired(true))
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

// --- 4. تسجيل الأوامر والدردشة التلقائية ---
client.once('ready', async () => {
    console.log(`✅ تم تشغيل البوت بنجاح باسم: ${client.user.tag}`);
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

    // إعداد الـ Timer للدردشة التلقائية كل 30 دقيقة (30 * 60 * 1000 ms)
    if (!autoChatInterval) {
        autoChatInterval = setInterval(async () => {
            for (const [guildId, config] of autoChatSettings.entries()) {
                if (!config.enabled || !config.channelId) continue;
                try {
                    const guild = await client.guilds.fetch(guildId).catch(() => null);
                    if (!guild) continue;
                    const channel = await guild.channels.fetch(config.channelId).catch(() => null);
                    if (!channel) continue;

                    const prompt = "اكتب رسالة قصيرة، لطيفة وتفاعلية للدردشة مع الأعضاء في السيرفر لفتح موضوع نقاش جانبي مسلي.";
                    const result = await aiModel.generateContent(prompt);
                    const replyText = result.response.text();

                    await channel.send(replyText);
                } catch (e) {
                    console.error('خطأ في إرسال الـ Auto-Chat:', e);
                }
            }
        }, 30 * 60 * 1000);
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
        await selectedChannel.send(`✅ تم تعيين هذه القناة لاستقبال جميع لوغات وتنبيهات البوت بنجاح!`);
        return interaction.reply({ content: `✅ تم ضبط روم اللوغ بنجاح على القناة ${selectedChannel}.`, flags: MessageFlags.Ephemeral });
    }

    // --- أمر /autochat ---
    if (commandName === 'autochat') {
        const status = options.getString('status');
        const channel = options.getChannel('channel');

        if (status === 'on') {
            if (!channel) {
                return interaction.reply({ content: '❌ يجب عليك اختيار القناة النصية المراد التحدث فيها عند التفعيل!', flags: MessageFlags.Ephemeral });
            }
            autoChatSettings.set(guild.id, { enabled: true, channelId: channel.id });
            return interaction.reply({ content: `✅ تم تفعيل الدردشة التلقائية كل 30 دقيقة في القناة ${channel}.`, flags: MessageFlags.Ephemeral });
        } else {
            autoChatSettings.set(guild.id, { enabled: false, channelId: null });
            return interaction.reply({ content: `🛑 تم إيقاف الدردشة التلقائية بنجاح.`, flags: MessageFlags.Ephemeral });
        }
    }

    // --- أمر /afkvoice ---
    if (commandName === 'afkvoice') {
        const action = options.getString('action');
        const channel = options.getChannel('channel');

        if (action === 'join') {
            if (!channel) {
                return interaction.reply({ content: '❌ يجب تحديد القناة الصوتية المراد البقاء فيها!', flags: MessageFlags.Ephemeral });
            }
            afkVoiceChannels.set(guild.id, channel.id);
            connectToAfkVoice(guild, channel.id);
            return interaction.reply({ content: `🎙️✅ تم دخول الروم الصوتي ${channel} وسيظل البوت متواجداً فيه 24/7.`, flags: MessageFlags.Ephemeral });
        } else {
            const connection = getVoiceConnection(guild.id);
            if (connection) connection.destroy();
            afkVoiceChannels.delete(guild.id);
            return interaction.reply({ content: `🔴 تم خروج البوت من الروم الصوتي وتفكيك التواجد الدائم.`, flags: MessageFlags.Ephemeral });
        }
    }

    if (commandName === 'warn') {
        const targetUser = options.getUser('user');
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';

        if (!member) return interaction.reply({ content: '❌ لم يتم العثور على العضو.', flags: MessageFlags.Ephemeral });

        if (!warningsDB.has(targetUser.id)) warningsDB.set(targetUser.id, []);
        const userWarns = warningsDB.get(targetUser.id);
        const warnId = userWarns.length + 1;
        userWarns.push({ id: warnId, reason, moderator: interaction.user.tag, date: new Date().toLocaleString('ar-EG') });

        try { await targetUser.send(`⚠️ **تنبيه:** تلقيت تحذيراً رقم (#${warnId}) في سيرفر **${guild.name}**\n**السبب:** ${reason}`); } catch (e) {}
        try { await member.timeout(60 * 1000, reason); } catch (e) {}

        if (logChannel) {
            await logChannel.send(`⚠️ **تحذير جديد (#${warnId}):**\n• **المستهدف:** ${targetUser.tag}\n• **المشرف:** ${interaction.user.tag}\n• **السبب:** ${reason}`);
        }
        await interaction.reply({ content: `✅ تم تحذير ${targetUser.tag} برقم (#${warnId}).`, flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'history') {
        const targetUser = options.getUser('user');
        const userWarns = warningsDB.get(targetUser.id) || [];
        if (userWarns.length === 0) {
            return interaction.reply({ content: `ℹ️ العضو ${targetUser.tag} ليس لديه تحذيرات.`, flags: MessageFlags.Ephemeral });
        }
        let historyText = `📜 **سجل تحذيرات ${targetUser.tag}:**\n\n`;
        userWarns.forEach(w => {
            historyText += `🔹 **رقم التحذير:** #${w.id}\n• **السبب:** ${w.reason}\n• **بواسطة:** ${w.moderator}\n• **التاريخ:** ${w.date}\n-------------------\n`;
        });
        await interaction.reply({ content: historyText, flags: MessageFlags.Ephemeral });
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
        if (logChannel) {
            await logChannel.send(`🟢 **إلغاء تحذير:**\n• **العضو:** ${targetUser.tag}\n• **التحذير المزال:** #${warnId}\n• **المشرف:** ${interaction.user.tag}`);
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
                await logChannel.send(`🔇 **تايم أوت:**\n• **العضو:** ${targetUser.tag}\n• **المدة:** ${durationInput}\n• **المشرف:** ${interaction.user.tag}\n• **السبب:** ${reason}`);
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
                await logChannel.send(`🔊 **إزالة تايم أوت:**\n• **العضو:** ${targetUser.tag}\n• **المشرف:** ${interaction.user.tag}`);
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
                await logChannel.send(`👢 **طرد عضو (Kick):**\n• **المطرود:** ${targetUser.tag}\n• **المشرف:** ${interaction.user.tag}\n• **السبب:** ${reason}`);
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
                await logChannel.send(`🔨 **حظر عضو (Ban):**\n• **المحظور:** ${targetUser.tag}\n• **المشرف:** ${interaction.user.tag}\n• **السبب:** ${reason}`);
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
                await logChannel.send(`🔓 **فك حظر (Unban):**\n• **الآيدي المحرّر:** ${userId}\n• **المشرف:** ${interaction.user.tag}`);
            }
            await interaction.reply({ content: `✅ تم فك الحظر عن الحساب صاحب الآيدي (${userId}) بنجاح.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل فك الحظر!', flags: MessageFlags.Ephemeral });
        }
    }
});

// --- 6. الـ AI للرد على الفورمز و الـ Mentions ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // أ) الرد والمدح التلقائي عند اكتشاف إرسال نموذج / فورم (Form Submission)
    const isFormMessage = message.embeds.some(e => e.title?.toLowerCase().includes('form') || e.title?.includes('نموذج') || e.title?.includes('تقديم')) 
                          || message.content.toLowerCase().includes('form') 
                          || message.content.includes('تم إرسال نموذج');

    if (isFormMessage) {
        try {
            await message.channel.sendTyping();
            const prompt = `أنت بوت سيرفر ديسكورد. قم بكتابة رد مشجع ومادح ولطيف جداً لشخص قام للتو بتعبئة وإرسال نموذج أو فورم في السيرفر.`;
            const result = await aiModel.generateContent(prompt);
            await message.reply(result.response.text());
            return;
        } catch (e) {
            console.error('خطأ في الرد على الفورم:', e);
        }
    }

    // ب) الرد بالذكاء الاصطناعي عند الإشارة للبوت (@Mention)
    if (message.mentions.has(client.user.id)) {
        const prompt = message.content.replace(/<@!?\d+>/g, '').trim();
        if (!prompt) return message.reply('نعم؟ تفضل وسلني عن أي شيء!');

        try {
            await message.channel.sendTyping();
            const result = await aiModel.generateContent(prompt);
            const responseText = result.response.text();

            if (responseText.length > 2000) {
                await message.reply(responseText.slice(0, 1990) + '...');
            } else {
                await message.reply(responseText);
            }
        } catch (error) {
            console.error('خطأ في الـ AI:', error);
            await message.reply('❌ حدث خطأ أثناء الاتصال بالذكاء الاصطناعي.');
        }
    }
});

// --- 7. أحداث اللوغ بالتكامل مع الـ Audit Logs ---

client.on('messageDelete', async (message) => {
    if (message.author?.bot || !message.guild) return;
    const logChannel = await getLogChannel(message.guild);
    if (!logChannel) return;

    let executor = message.author.tag;
    try {
        const fetchedLogs = await message.guild.fetchAuditLogs({
            limit: 1,
            type: AuditLogEvent.MessageDelete,
        });
        const deletionLog = fetchedLogs.entries.first();
        if (deletionLog && deletionLog.target.id === message.author.id && (Date.now() - deletionLog.createdTimestamp) < 5000) {
            executor = deletionLog.executor.tag;
        }
    } catch (e) {}

    try {
        await logChannel.send(
            `🗑️ **تم حذف رسالة:**\n` +
            `• **صاحب الرسالة:** ${message.author.tag} (${message.author})\n` +
            `• **الحاذف (الادمن/العضو):** ${executor}\n` +
            `• **الروم:** ${message.channel}\n` +
            `• **المحتوى:**\n> ${message.content || 'محتوى غير نصي'}`
        );
    } catch (e) {}
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (oldMessage.author?.bot || !oldMessage.guild) return;
    if (oldMessage.content === newMessage.content) return;

    const logChannel = await getLogChannel(oldMessage.guild);
    if (!logChannel) return;

    try {
        await logChannel.send(
            `✏️ **تم تعديل رسالة:**\n` +
            `• **العضو:** ${oldMessage.author.tag} (${oldMessage.author})\n` +
            `• **الروم:** ${oldMessage.channel}\n` +
            `• **قبل:** ${oldMessage.content || 'غير نصي'}\n` +
            `• **بعد:** ${newMessage.content || 'غير نصي'}\n` +
            `• **الرابط:** [انتقل للرسالة](${newMessage.url})`
        );
    } catch (e) {}
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const logChannel = await getLogChannel(newState.guild);
    if (!logChannel) return;

    const member = newState.member;

    const getAdminExecutor = async () => {
        try {
            const fetchedLogs = await newState.guild.fetchAuditLogs({
                limit: 1,
                type: AuditLogEvent.MemberUpdate,
            });
            const logEntry = fetchedLogs.entries.first();
            if (logEntry && logEntry.target.id === member.id && (Date.now() - logEntry.createdTimestamp) < 5000) {
                return logEntry.executor.tag;
            }
        } catch (e) {}
        return 'غير معروف/إداري';
    };

    if (!oldState.serverMute && newState.serverMute) {
        const admin = await getAdminExecutor();
        await logChannel.send(`🎙️🔇 **ميوت فويس إداري:**\n• **العضو المستهدف:** ${member.user.tag} (${member})\n• **بواسطة الادمن:** ${admin}`);
    } else if (oldState.serverMute && !newState.serverMute) {
        const admin = await getAdminExecutor();
        await logChannel.send(`🎙️🔊 **فك ميوت فويس إداري:**\n• **العضو:** ${member.user.tag} (${member})\n• **بواسطة الادمن:** ${admin}`);
    }

    if (!oldState.serverDeafen && newState.serverDeafen) {
        const admin = await getAdminExecutor();
        await logChannel.send(`🎧🔇 **إسكات سماعات إداري:**\n• **العضو:** ${member.user.tag} (${member})\n• **بواسطة الادمن:** ${admin}`);
    } else if (oldState.serverDeafen && !newState.serverDeafen) {
        const admin = await getAdminExecutor();
        await logChannel.send(`🎧🔊 **فك إسكات السماعات:**\n• **العضو:** ${member.user.tag} (${member})\n• **بواسطة الادمن:** ${admin}`);
    }
});

client.login(TOKEN);
