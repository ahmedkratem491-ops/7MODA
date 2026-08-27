const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const config = require('./config.json');

const commands = [
    // 1. أمر التحذير
    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('إضافة تحذير لعضو مع سبب')
        .addUserOption(opt => opt.setName('target').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('سبب التحذير').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    // 2. أمر التايم أوت
    new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('عزل عضو مؤقتاً')
        .addUserOption(opt => opt.setName('target').setDescription('العضو المستهدف').setRequired(true))
        .addIntegerOption(opt => opt.setName('duration').setDescription('المدة بالدقائق').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('السبب').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    // 3. أمر الطرد
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('طرد عضو من السيرفر')
        .addUserOption(opt => opt.setName('target').setDescription('العضو').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('السبب').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    // 4. أمر الحظر
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('حظر عضو من السيرفر')
        .addUserOption(opt => opt.setName('target').setDescription('العضو').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('السبب').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    // 5. أمر إلغاء الحظر
    new SlashCommandBuilder()
        .setName('unban')
        .setDescription('إلغاء حظر عضو عبر ID')
        .addStringOption(opt => opt.setName('userid').setDescription('ID العضو').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    // 6. أمر مسح الرسائل
    new SlashCommandBuilder()
        .setName('clear')
        .setDescription('تنظيف الرسائل في الشات')
        .addIntegerOption(opt => opt.setName('amount').setDescription('عدد الرسائل (1-100)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    // 7. أمر تحديد روم السجلات
    new SlashCommandBuilder()
        .setName('setlog')
        .setDescription('تحديد روم السجلات (Logs)')
        .addChannelOption(opt => opt.setName('channel').setDescription('اختر القناة').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // 8. أمر استثناء فئة من الحماية
    new SlashCommandBuilder()
        .setName('ignorecategory')
        .setDescription('استثناء/تفعيل حماية فئة معينة')
        .addChannelOption(opt => opt.setName('category').setDescription('اختر الفئة').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // 9. أمر سرعة الاستجابة
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('فحص سرعة استجابة البوت وحالة الاتصال')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
    try {
        console.log('⏳ جاري تسجيل جميع أوامر السلاش عند ديسكورد...');
        await rest.put(
            Routes.applicationCommands(config.clientId),
            { body: commands }
        );
        console.log('✅ تم تسجيل أوامر السلاش بنجاح!');
    } catch (error) {
        console.error('❌ خطأ في تسجيل الأوامر:', error);
    }
})();