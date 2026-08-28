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

// قاعدة بيانات مصغرة في الذاكرة لتخزين التحذيرات
// (في حال إعادة تشغيل البوت ستبقى الذاكرة مسجلة خلال فترة التشغيل)
const warningsDB = new Map(); 

// ⚠️ ضع هنا التوكين وآيدي روم اللوغ الخاص بك
const TOKEN = process.env.DISCORD_TOKEN; // أو ضع التوكين بين علامات " "
const LOG_CHANNEL_ID = 'ضع_هنا_ID_روم_اللوغ';

// --- 3. تعريف أوامر السلاش (Slash Commands) ---
const commands = [
    // أمر التحذير /warn
    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('تحذير عضو وتطبيق تايم أوت تلقائي')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('سبب التحذير').setRequired(false)),

    // أمر عرض سجل التحذيرات /history
    new SlashCommandBuilder()
        .setName('history')
        .setDescription('عرض سجل تحذيرات عضو معين')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true)),

    // أمر إلغاء تحذير معّين /unwarn
    new SlashCommandBuilder()
        .setName('unwarn')
        .setDescription('إلغاء تحذير محدد لعضو برقم التحذير')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
        .addIntegerOption(opt => opt.setName('warn_id').setDescription('رقم التحذير المراد حذفه').setRequired(true)),

    // أمر إزالة التايم أوت /untimeout
    new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription('إلغاء التايم أوت عن عضو')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt => opt.setName('user').setDescription('العضو المستهدف').setRequired(true))
].map(cmd => cmd.toJSON());

// --- 4. تسجيل الأوامر عند الإقلاع ---
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

// --- 5. التعامل مع أوامر السلاش ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guild } = interaction;
    const targetUser = options.getUser('user');
    const member = await guild.members.fetch(targetUser.id).catch(() => null);
    const logChannel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

    if (!member) {
        return interaction.reply({ content: '❌ لم يتم العثور على هذا العضو في السيرفر.', flags: MessageFlags.Ephemeral });
    }

    // --- أمر التحذير (/warn) ---
    if (commandName === 'warn') {
        const reason = options.getString('reason') || 'لا يوجد سبب محدد';
        
        // حفظ التحذير في السجل
        if (!warningsDB.has(targetUser.id)) {
            warningsDB.set(targetUser.id, []);
        }
        const userWarns = warningsDB.get(targetUser.id);
        const warnId = userWarns.length + 1;
        userWarns.push({ id: warnId, reason, moderator: interaction.user.tag, date: new Date().toLocaleString('ar-EG') });

        // 1. إرسال للخاص
        try {
            await targetUser.send(`⚠️ **تنبيه:** تلقيت تحذيراً رقم (#${warnId}) في سيرفر **${guild.name}**\n**السبب:** ${reason}`);
        } catch (err) {
            console.log('لم يتم إرسال الخاص (الخاص مقفل من المستخدم).');
        }

        // 2. تطبيق تايم أوت (دقيقة كمثال)
        try {
            await member.timeout(60 * 1000, reason);
        } catch (err) {
            console.log('فشل تطبيق التايم أوت بسبب نقص الصلاحيات أو ترتيب الرتب.');
        }

        // 3. إرسال اللوغ
        if (logChannel) {
            await logChannel.send(
                `⚠️ **تحذير جديد (#${warnId}):**\n` +
                `• **المستهدف:** ${targetUser.tag} (${targetUser})\n` +
                `• **المشرف:** ${interaction.user.tag}\n` +
                `• **السبب:** ${reason}`
            );
        }

        await interaction.reply({ content: `✅ تم تحذير ${targetUser.tag} بنجاح (تحذير رقم #${warnId}).`, flags: MessageFlags.Ephemeral });
    }

    // --- أمر السجل (/history) ---
    if (commandName === 'history') {
        const userWarns = warningsDB.get(targetUser.id) || [];
        if (userWarns.length === 0) {
            return interaction.reply({ content: `ℹ️ العضو ${targetUser.tag} ليس لديه أي تحذيرات مسجلة.`, flags: MessageFlags.Ephemeral });
        }

        let historyText = `📜 **سجل تحذيرات ${targetUser.tag}:**\n\n`;
        userWarns.forEach(w => {
            historyText += `🔹 **رقم التحذير:** #${w.id}\n• **السبب:** ${w.reason}\n• **بواسطة:** ${w.moderator}\n• **التاريخ:** ${w.date}\n-------------------\n`;
        });

        await interaction.reply({ content: historyText, flags: MessageFlags.Ephemeral });
    }

    // --- أمر إلغاء التحذير (/unwarn) ---
    if (commandName === 'unwarn') {
        const warnId = options.getInteger('warn_id');
        let userWarns = warningsDB.get(targetUser.id) || [];

        const index = userWarns.findIndex(w => w.id === warnId);
        if (index === -1) {
            return interaction.reply({ content: `❌ لم يتم العثور على تحذير برقم (#${warnId}) لهذا العضو.`, flags: MessageFlags.Ephemeral });
        }

        userWarns.splice(index, 1);
        warningsDB.set(targetUser.id, userWarns);

        if (logChannel) {
            await logChannel.send(
                `🟢 **إلغاء تحذير:**\n` +
                `• **العضو:** ${targetUser.tag}\n` +
                `• **رقم التحذير المزال:** #${warnId}\n` +
                `• **بواسطة المشرف:** ${interaction.user.tag}`
            );
        }

        await interaction.reply({ content: `✅ تم إلغاء التحذير رقم (#${warnId}) عن ${targetUser.tag}.`, flags: MessageFlags.Ephemeral });
    }

    // --- أمر إلغاء التايم أوت (/untimeout) ---
    if (commandName === 'untimeout') {
        try {
            await member.timeout(null);

            if (logChannel) {
                await logChannel.send(
                    `🔊 **إزالة التايم أوت:**\n` +
                    `• **العضو:** ${targetUser.tag} (${targetUser})\n` +
                    `• **بواسطة المشرف:** ${interaction.user.tag}`
                );
            }

            await interaction.reply({ content: `✅ تم إلغاء التايم أوت عن ${targetUser.tag}.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: '❌ فشل إزالة التايم أوت! تأكد أن رتبة البوت أعلى من العضو.', flags: MessageFlags.Ephemeral });
        }
    }
});

// --- 6. لوغ حذف وتعديل الرسائل ---

// لوغ الحذف
client.on('messageDelete', async (message) => {
    if (message.author?.bot || !message.guild) return;
    try {
        const logChannel = await message.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!logChannel) return;

        const content = message.content || 'محتوى غير نصي (صورة أو مرفق)';
        await logChannel.send(
            `🗑️ **تم حذف رسالة:**\n` +
            `• **العضو:** ${message.author.tag} (${message.author})\n` +
            `• **الروم:** ${message.channel}\n` +
            `• **المحتوى:**\n> ${content}`
        );
    } catch (e) { console.error(e); }
});

// لوغ التعديل
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
    } catch (e) { console.error(e); }
});

// تسجيل الدخول
client.login(TOKEN);
