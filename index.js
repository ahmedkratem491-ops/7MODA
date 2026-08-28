const express = require('express');
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    MessageFlags 
} = require('discord.js');

// --- 1. خادم HTTP لإبقاء البوت شغال على Render ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(port, () => console.log(`Server is running on port ${port}`));

// --- 2. إعداد البوت والـ Intents ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// قاعدة بيانات التحذيرات في الذاكرة
const warningsDB = new Map(); 

// ⚠️ الإعدادات (ضع التوكين وآيدي اللوغ هنا)
const TOKEN = process.env.DISCORD_TOKEN || 'ضع_التوكين_هنا';
const LOG_CHANNEL_ID = 'ضع_ID_روم_اللوغ_هنا';

// دالة تحويل صيغ الوقت (m/h/d) إلى ملي ثانية
function parseDuration(durationStr) {
    if (!durationStr) return null;
    const regex = /^(\d+)([mMhHdD])$/;
    const match = durationStr.match(regex);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
        case 'm': return value * 60 * 1000;              // دقائق
        case 'h': return value * 60 * 60 * 1000;         // ساعات
        case 'd': return value * 24 * 60 * 60 * 1000;    // أيام
        default: return null;
    }
}

// --- 3. قائمة أوامر السلاش (Slash Commands) ---
const commands = [
    // 1. أمر التحذير (/warn)
    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('تحذير عضو وتطبيق تايم أوت تلقائي عليه')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('سبب التحذير').setRequired(false)),

    // 2. أمر عرض السجل (/history)
    new SlashCommandBuilder()
        .setName('history')
        .setDescription('عرض سجل تحذيرات عضو')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true)),

    // 3. أمر إلغاء التحذير (/unwarn)
    new SlashCommandBuilder()
        .setName('unwarn')
        .setDescription('إلغاء تحذير معّين لعضو برقم التحذير')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
        .addIntegerOption(opt => opt.setName('warn_id').setDescription('رقم التحذير').setRequired(true)),

    // 4. أمر التايم أوت المباشر (/timeout)
    new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('إعطاء تايم أوت لعضو (مثال: 10m أو 2h أو 1d)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('duration').setDescription('المدة (مثال: 10m للدقائق أو 2h للساعات أو 1d للأيام)').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('السبب').setRequired(false)),

    // 5. أمر إلغاء التايم أوت (/untimeout)
    new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription('إزالة التايم أوت عن عضو')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true)),

    // 6. أمر الطرد (/kick)
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('طرد عضو من السيرفر')
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المرادطرده').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('سبب الطرد').setRequired(false)),

    // 7. أمر البان (/ban)
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('حظر عضو نهائياً من السيرفر')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المراد حظره').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('سبب الحظر').setRequired(false)),

    // 8. أمر فك البان (/unban)
    new SlashCommandBuilder()
        .setName('unban')
        .setDescription('فك الحظر عن عضو باستخدام ID الحساب')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addStringOption(opt => opt.setName('user_id').setDescription('آيدي (ID) العضو المحظور').setRequired(true))
].map(cmd => cmd.toJSON());

// --- 4. تسجيل الأوامر عند التشغيل ---
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
});

// --- 5. تنفيذ أوامر السلاش ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guild } = interaction;
    const logChannel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

    // --- أمر /warn ---
    if (commandName === 'warn') {
        const targetUser = options.getUser('user');
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';
        
        if (!member) return interaction.reply({ content: '❌ لم يتم العثور على العضو.', flags: MessageFlags.Ephemeral });

        if (!warningsDB.has(targetUser.id)) warningsDB.set(targetUser.id, []);
        const userWarns = warningsDB.get(targetUser.id);
        const warnId = userWarns.length + 1;
        userWarns.push({ id: warnId, reason, moderator: interaction.user.tag, date: new Date().toLocaleString('ar-EG') });

        try {
            await targetUser.send(`⚠️ **تنبيه:** تلقيت تحذيراً رقم (#${warnId}) في سيرفر **${guild.name}**\n**السبب:** ${reason}`);
        } catch (e) {}

        try { await member.timeout(60 * 1000, reason); } catch (e) {}

        if (logChannel) {
            await logChannel.send(`⚠️ **تحذير جديد (#${warnId}):**\n• **المستهدف:** ${targetUser.tag}\n• **المشرف:** ${interaction.user.tag}\n• **السبب:** ${reason}`);
        }
        await interaction.reply({ content: `✅ تم تحذير ${targetUser.tag} برقم (#${warnId}).`, flags: MessageFlags.Ephemeral });
    }

    // --- أمر /history ---
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

    // --- أمر /unwarn ---
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

    // --- أمر /timeout ---
    if (commandName === 'timeout') {
        const targetUser = options.getUser('user');
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        const durationInput = options.getString('duration');
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';

        if (!member) return interaction.reply({ content: '❌ لم يتم العثور على العضو.', flags: MessageFlags.Ephemeral });

        const ms = parseDuration(durationInput);
        if (!ms) {
            return interaction.reply({ content: '❌ صيغة الوقت غير صحيحة! استخدم صيغ مثل: `10m` للدقائق، `2h` للساعات، `1d` للأيام (كبيرة أو صغيرة).', flags: MessageFlags.Ephemeral });
        }

        try {
            await member.timeout(ms, reason);
            if (logChannel) {
                await logChannel.send(`🔇 **تايم أوت:**\n• **العضو:** ${targetUser.tag}\n• **المدة:** ${durationInput}\n• **المشرف:** ${interaction.user.tag}\n• **السبب:** ${reason}`);
            }
            await interaction.reply({ content: `✅ تم تطبيق تايم أوت على ${targetUser.tag} لمدة ${durationInput}.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل تطبيق التايم أوت! تأكد من صلاحيات البوت وأن رتبته أعلى من العضو.', flags: MessageFlags.Ephemeral });
        }
    }

    // --- أمر /untimeout ---
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

    // --- أمر /kick ---
    if (commandName === 'kick') {
        const targetUser = options.getUser('user');
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';

        if (!member) return interaction.reply({ content: '❌ لم يتم العثور على العضو في السيرفر.', flags: MessageFlags.Ephemeral });

        try {
            await member.kick(reason);
            if (logChannel) {
                await logChannel.send(`👢 **طرد عضو (Kick):**\n• **المطرود:** ${targetUser.tag}\n• **المشرف:** ${interaction.user.tag}\n• **السبب:** ${reason}`);
            }
            await interaction.reply({ content: `✅ تم طرد ${targetUser.tag} بنجاح.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل طرد العضو! تأكد أن رتبة البوت أعلى من العضو.', flags: MessageFlags.Ephemeral });
        }
    }

    // --- أمر /ban ---
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
            await interaction.reply({ content: '❌ فشل تنفيذ الحظر! تأكد أن رتبة البوت أعلى من العضو.', flags: MessageFlags.Ephemeral });
        }
    }

    // --- أمر /unban ---
    if (commandName === 'unban') {
        const userId = options.getString('user_id');

        try {
            await guild.members.unban(userId);
            if (logChannel) {
                await logChannel.send(`🔓 **فك حظر (Unban):**\n• **الآيدي المحرّر:** ${userId}\n• **المشرف:** ${interaction.user.tag}`);
            }
            await interaction.reply({ content: `✅ تم فك الحظر عن الحساب صاحب الآيدي (${userId}) بنجاح.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل فك الحظر! تأكد أن الـ ID صحيح وأن الحساب محظور بالأساس.', flags: MessageFlags.Ephemeral });
        }
    }
});

// --- 6. لوغ حذف وتعديل الرسائل ---
client.on('messageDelete', async (message) => {
    if (message.author?.bot || !message.guild) return;
    try {
        const logChannel = await message.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!logChannel) return;

        await logChannel.send(
            `🗑️ **تم حذف رسالة:**\n` +
            `• **العضو:** ${message.author.tag} (${message.author})\n` +
            `• **الروم:** ${message.channel}\n` +
            `• **المحتوى:**\n> ${message.content || 'محتوى غير نصي'}`
        );
    } catch (e) {}
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (oldMessage.author?.bot || !oldMessage.guild) return;
    if (oldMessage.content === newMessage.content) return;

    try {
        const logChannel = await oldMessage.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!logChannel) return;

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

client.login(TOKEN);
