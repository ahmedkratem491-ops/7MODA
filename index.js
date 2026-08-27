const { 
    Client, GatewayIntentBits, Partials, EmbedBuilder, 
    PermissionFlagsBits, ChannelType 
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer } = require('@discordjs/voice');
const { GoogleGenAI } = require('@google/genai');
const config = require('./config.json');

// إعداد الذكاء الاصطناعي
const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// قواعد البيانات المؤقتة في الذاكرة
let ignoredCategories = new Set();
let logChannelId = null;

// ضبط معدل التفاعل البشري في الشات (5 رسائل كحد أقصى كل 30 دقيقة)
let chatInteractionCount = 0;
setInterval(() => { chatInteractionCount = 0; }, 30 * 60 * 1000);

// دالة مساعدة لإرسال السجلات (Logs)
async function sendLog(guild, title, description, color = 'Blue') {
    if (!logChannelId) return;
    const logChan = guild.channels.cache.get(logChannelId);
    if (!logChan) return;

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();

    logChan.send({ embeds: [embed] }).catch(() => {});
}

// ----------------------------------------------------
// 1. تشغيل البوت والربط بالصوت 24/7 (AFK Voice Connection)
// ----------------------------------------------------
client.once('clientReady', async () => {
    console.log(`✅ تم تشغيل البوت بنجاح باسم: ${client.user.tag}`);

    // الانضمام الدائم للروم الصوتي
    if (config.afkVoiceChannelId) {
        try {
            const guild = client.guilds.cache.get(config.guildId);
            const voiceChannel = guild?.channels.cache.get(config.afkVoiceChannelId);

            if (voiceChannel) {
                joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                    selfDeaf: true,  // كتم السماعة لتوفير الموارد
                    selfMute: true   // كتم المايك
                });
                console.log(`🎙️ تم الاتصال بالروم الصوتي 24/7: ${voiceChannel.name}`);
            }
        } catch (err) {
            console.error('❌ تعذر الاتصال بالروم الصوتي:', err.message);
        }
    }
});

// ----------------------------------------------------
// 2. معالجة أوامر السلاش (Slash Commands Handling)
// ----------------------------------------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guild, member } = interaction;

    // أمر Ping
    if (commandName === 'ping') {
        return interaction.reply({ content: `🏓 سرعة الاستجابة: \`${client.ws.ping}ms\``, ephemeral: true });
    }

    // أمر تحديد روم السجلات
    if (commandName === 'setlog') {
        const channel = options.getChannel('channel');
        logChannelId = channel.id;
        await sendLog(guild, '⚙️ تحديث الإعدادات', `تم تعيين القناة ${channel} كـ روم للسجلات بواسطة ${member}`);
        return interaction.reply({ content: `✅ تم تعيين روم السجلات بنجاح: ${channel}`, ephemeral: true });
    }

    // أمر استثناء فئة من الحماية
    if (commandName === 'ignorecategory') {
        const category = options.getChannel('category');
        if (ignoredCategories.has(category.id)) {
            ignoredCategories.delete(category.id);
            return interaction.reply({ content: `✅ تم تفعيل الحماية للفئة: **${category.name}**`, ephemeral: true });
        } else {
            ignoredCategories.add(category.id);
            return interaction.reply({ content: `🛡️ تم استثناء الفئة من الحماية: **${category.name}**`, ephemeral: true });
        }
    }

    // أمر التحذير (Warn)
    if (commandName === 'warn') {
        const target = options.getUser('target');
        const reason = options.getString('reason');

        await sendLog(guild, '⚠️ تحذير جديد', `**المستهدف:** ${target}\n**بواسطة:** ${member}\n**السبب:** ${reason}`, 'Yellow');
        return interaction.reply({ content: `✅ تم إرسال تحذير إلى ${target} بنجاح.` });
    }

    // أمر التايم أوت (Timeout)
    if (commandName === 'timeout') {
        const targetMember = options.getMember('target');
        const duration = options.getInteger('duration');
        const reason = options.getString('reason') || 'لم يُذكر سبب';

        if (!targetMember) return interaction.reply({ content: '❌ العضو غير موجود بالسيرفر.', ephemeral: true });

        await targetMember.timeout(duration * 60 * 1000, reason);
        await sendLog(guild, '⏳ تايم أوت (Timeout)', `**العضو:** ${targetMember}\n**المدة:** ${duration} دقيقة\n**السبب:** ${reason}`, 'Orange');
        return interaction.reply({ content: `✅ تم تطبيق تايم أوت على ${targetMember} لمدة ${duration} دقيقة.` });
    }

    // أمر الطرد (Kick)
    if (commandName === 'kick') {
        const targetMember = options.getMember('target');
        const reason = options.getString('reason') || 'بدون سبب';

        if (!targetMember) return interaction.reply({ content: '❌ العضو غير موجود.', ephemeral: true });

        await targetMember.kick(reason);
        await sendLog(guild, '👞 طرد عضو (Kick)', `**العضو:** ${targetMember.user.tag}\n**بواسطة:** ${member}\n**السبب:** ${reason}`, 'Red');
        return interaction.reply({ content: `✅ تم طرد ${targetMember.user.tag} من السيرفر.` });
    }

    // أمر الحظر (Ban)
    if (commandName === 'ban') {
        const targetUser = options.getUser('target');
        const reason = options.getString('reason') || 'بدون سبب';

        await guild.members.ban(targetUser.id, { reason });
        await sendLog(guild, '🔨 حظر عضو (Ban)', `**العضو:** ${targetUser.tag}\n**بواسطة:** ${member}\n**السبب:** ${reason}`, 'DarkRed');
        return interaction.reply({ content: `✅ تم حظر ${targetUser.tag} بنجاح.` });
    }

    // أمر إلغاء الحظر (Unban)
    if (commandName === 'unban') {
        const userId = options.getString('userid');
        try {
            await guild.members.unban(userId);
            await sendLog(guild, '🔓 إلغاء حظر', `تم إلغاء الحظر عن المستخدم ID: \`${userId}\` بواسطة ${member}`, 'Green');
            return interaction.reply({ content: `✅ تم إلغاء حظر المستخدم بنجاح.` });
        } catch (e) {
            return interaction.reply({ content: '❌ تعذر العثور على حظر لهذا الرقم ID.', ephemeral: true });
        }
    }

    // أمر مسح الرسائل (Clear)
    if (commandName === 'clear') {
        const amount = options.getInteger('amount');
        if (amount < 1 || amount > 100) return interaction.reply({ content: '⚠️ أدخل رقماً بين 1 و 100.', ephemeral: true });

        const deleted = await interaction.channel.bulkDelete(amount, true);
        await sendLog(guild, '🧹 تنظيف الشات', `تم حذف **${deleted.size}** رسالة في القناة ${interaction.channel} بواسطة ${member}`, 'Purple');
        return interaction.reply({ content: `✅ تم حذف ${deleted.size} رسالة بنجاح.`, ephemeral: true });
    }
});

// ----------------------------------------------------
// 3. الترحب بالإعضاء الجدد والمنشن في الشات
// ----------------------------------------------------
client.on('guildMemberAdd', async member => {
    // إرسال سجل دخول
    await sendLog(member.guild, '📥 دخول عضو جديد', `انضم العضو: ${member} (\`${member.id}\`)`, 'Green');

    // الترحيب المباشر في القناة العامة
    const systemChannel = member.guild.systemChannel;
    if (systemChannel) {
        const welcomeGreet = `منور السيرفر يا ${member}! 🌹 نورتنا نتمنى لك وقتاً ممتعاً.`;
        systemChannel.send(welcomeGreet).catch(() => {});
    }
});

// ----------------------------------------------------
// 4. التفاعل الإنساني الموزون في الشات العامة (Human Chat)
// ----------------------------------------------------
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    // التفاعل مع الفيديوهات والمنشورات داخل قنوات الفورم (Forum Threads)
    if (message.channel.isThread() && message.channel.parent?.type === ChannelType.GuildForum) {
        if (message.attachments.size > 0) {
            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: 'علّق بإعجاب واحترافية وبشكل مشجع وقصير جداً باللغة العربية على هذا التصميم/المنشور المرفق.'
                });
                await message.reply(`${response.text}\nCc: @Designers`);
            } catch (err) {
                console.error('AI Forum Error:', err);
            }
        }
        return;
    }

    // التفاعل الطبيعي القليل مع الشات العامة (أقصى حد 5 رسائل كل 30 دقيقة)
    if (chatInteractionCount < 5 && Math.random() < 0.05) { // احتمال خفيف للرد
        try {
            chatInteractionCount++;
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `رد بشكل عفوي وقصير جداً بلغة عربية عامية بسيطة كأنك عضو عادي بالسيرفر على هذه الرسالة: "${message.content}"`
            });
            message.channel.sendTyping();
            setTimeout(() => {
                message.reply(response.text).catch(() => {});
            }, 2000);
        } catch (e) {}
    }
});

// ----------------------------------------------------
// 5. سجل حماية الفئات وحذف القنوات (Protection Logs)
// ----------------------------------------------------
client.on('channelDelete', async channel => {
    if (channel.parentId && ignoredCategories.has(channel.parentId)) {
        console.log(`تم تجاهل حذف القناة لتبعيتها لفئة مستثناة: ${channel.parentId}`);
        return;
    }
    await sendLog(channel.guild, '🚨 حذف قناة', `تم حذف القناة: **${channel.name}**`, 'Red');
});

// تسجيل الدخول
client.login(config.token);