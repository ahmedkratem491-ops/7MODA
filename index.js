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
    NoSubscriberBehavior
} = require('@discordjs/voice');
const { GoogleGenAI } = require('@google/genai');
const play = require('play-dl');

// --- 1. خادم HTTP لإبقاء البوت شغال على Render ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(port, () => console.log(`Server is running on port ${port}`));

// --- 2. إعداد الـ AI والبوت والـ Cookies ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ضبط كوكيز يوتيوب لتجاوز حظر Render من خلال متغيرات البيئة
if (process.env.YOUTUBE_COOKIE) {
    play.setToken({
        youtube: {
            cookie: process.env.YOUTUBE_COOKIE
        }
    });
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

// قواعد البيانات وطوابير التشغيل في الذاكرة
const warningsDB = new Map(); 
const logChannelsDB = new Map();
const autoChatSettings = new Map(); 
const afkVoiceChannels = new Map(); 
const musicQueue = new Map(); // طابور الموسيقى لكل سيرفر
let autoChatInterval = null;

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

    // --- أوامر التشغيل الصوتي (YouTube) ---
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

// --- 4. تسجيل الأوامر والدردشة التلقائية ---
client.once('clientReady', async () => {
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

    if (!autoChatInterval) {
        autoChatInterval = setInterval(async () => {
            for (const [guildId, config] of autoChatSettings.entries()) {
                if (!config.enabled || !config.channelId) continue;
                try {
                    const guild = await client.guilds.fetch(guildId).catch(() => null);
                    if (!guild) continue;
                    const channel = await guild.channels.fetch(config.channelId).catch(() => null);
                    if (!channel) continue;

                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: "اكتب رسالة قصيرة، لطيفة وتفاعلية للدردشة مع الأعضاء في السيرفر لفتح موضوع نقاش جانبي مسلي."
                    });
                    await channel.send(response.text);
                } catch (e) {
                    console.error('خطأ في الـ Auto-Chat:', e);
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
            return interaction.reply({ content: `✅ تم تفعيل الدردشة التلقائية كل 30 دقيقة في ${channel}.`, flags: MessageFlags.Ephemeral });
        } else {
            autoChatSettings.set(guild.id, { enabled: false, channelId: null });
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
            connectToAfkVoice(guild, channel.id);
            return interaction.reply({ content: `🎙️✅ تم دخول الروم الصوتي ${channel} وسيظل البوت متواجداً فيه 24/7.`, flags: MessageFlags.Ephemeral });
        } else {
            const connection = getVoiceConnection(guild.id);
            if (connection) connection.destroy();
            afkVoiceChannels.delete(guild.id);
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
            const searchResults = await play.search(query, { limit: 1 });
            if (!searchResults || searchResults.length === 0) {
                return interaction.editReply('❌ لم يتم العثور على أي نتائج لهذا البحث في يوتيوب.');
            }

            const video = searchResults[0];
            const song = {
                title: video.title,
                url: video.url,
                duration: video.durationRaw,
                thumbnail: video.thumbnails[0]?.url
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
                    songs: [],
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
                        queueConstruct.songs.shift();
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
                            { name: 'القناة الصوتية', value: `${voiceChannel}`, inline: true }
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
                    .addFields({ name: 'المدة', value: song.duration || 'غير معروف', inline: true })
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

        serverQueue.player.stop();
        return interaction.reply('⏭️ تم تخطي المقطع الحالي.');
    }

    if (commandName === 'stop') {
        const serverQueue = musicQueue.get(guild.id);
        if (!serverQueue) return interaction.reply({ content: '❌ البوت لا يشغل أي شيء حالياً!', flags: MessageFlags.Ephemeral });

        serverQueue.songs = [];
        serverQueue.player.stop();
        if (serverQueue.connection) serverQueue.connection.destroy();
        musicQueue.delete(guild.id);

        return interaction.reply('⏹️ تم إيقاف التشغيل وتفريغ القائمة وإخراج البوت.');
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
    if (message.author.bot) return;

    const isFormMessage = message.embeds.some(e => e.title?.toLowerCase().includes('form') || e.title?.includes('نموذج') || e.title?.includes('تقديم')) 
                          || message.content.toLowerCase().includes('form') 
                          || message.content.includes('تم إرسال نموذج');

    if (isFormMessage) {
        try {
            await message.channel.sendTyping();
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: "أنت بوت سيرفر ديسكورد. قم بكتابة رد مشجع ومادح ولطيف جداً لشخص قام للتو بتعبئة وإرسال نموذج أو فورم في السيرفر."
            });
            await message.reply(response.text);
            return;
        } catch (e) {
            console.error('خطأ في الرد على الفورم:', e);
        }
    }

    if (message.mentions.has(client.user.id)) {
        const prompt = message.content.replace(/<@!?\d+>/g, '').trim();
        if (!prompt) return message.reply('نعم؟ تفضل وسلني عن أي شيء!');

        try {
            await message.channel.sendTyping();
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt
            });
            const responseText = response.text;

            if (responseText.length > 2000) {
                await message.reply(responseText.slice(0, 1990) + '...');
            } else {
                await message.reply(responseText);
            }
        } catch (error) {
            console.error('خطأ في الـ AI:', error);
            await message.reply('❌ تعذر الاتصال بالذكاء الاصطناعي حالياً.');
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
async function playSong(guild, song) {
    const serverQueue = musicQueue.get(guild.id);
    if (!song) {
        if (serverQueue.connection) serverQueue.connection.destroy();
        musicQueue.delete(guild.id);
        return;
    }

    try {
        const stream = await play.stream(song.url);
        const resource = createAudioResource(stream.stream, {
            inputType: stream.type
        });

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

client.login(TOKEN);
