// ===============================
// DISCORD COMMUNITY BOT — COMPLETE SLASH VERSION
// Features included:
// - Welcome + Auto Role + Welcome DM
// - Auto-moderation (bad words, link filter, basic anti-spam)
// - Reaction Roles (message panel + select menu)
// - Ticket Panel with category buttons
// - Economy (balance, daily, work, pay, shop, buy, gamble, leaderboard, inventory)
// - Leveling (xp per message, role rewards)
// - Verification (button captcha style)
// - Logging (join/leave/message delete/edit)
// NOTE: This is an in-memory demo. For production, persist using a DB (sqlite, json file, mongo, etc.).
// Replace all placeholder IDs and configure .env: TOKEN and CLIENT_ID
// ===============================

import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  SlashCommandBuilder,
  Routes,
  REST,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  ComponentType
} from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// -------------------------------
// IN-MEMORY DATABASE (replace with real DB)
// -------------------------------
const db = {
  economy: {},        // userId -> { coins, inventory: [] }
  dailyClaim: {},     // userId -> timestamp
  levels: {},         // userId -> { xp, level }
  levelRewards: {},   // level -> roleId
  shop: [             // shop items
    { id: 'role_vip', name: 'VIP Role', price: 500, type: 'role', meta: { roleId: 'VIP_ROLE_ID' } },
    { id: 'custom_name', name: 'Custom Name (demo)', price: 300, type: 'item' }
  ]
};

// -------------------------------
// CONFIG - replace these with real IDs
// -------------------------------
const WELCOME_CHANNEL_ID = 'WELCOME_CHANNEL_ID';
const LOG_CHANNEL_ID = 'LOG_CHANNEL_ID';
const AUTO_ROLE_ID = 'AUTO_ROLE_ID';
const REACTION_ROLE_CHANNEL_ID = 'REACTION_ROLE_CHANNEL_ID';
const REACTION_ROLE_MESSAGE_ID = 'REACTION_ROLE_MESSAGE_ID'; // if you pre-create message
const VERIFICATION_CHANNEL_ID = 'VERIFICATION_CHANNEL_ID';
const VERIFIED_ROLE_ID = 'VERIFIED_ROLE_ID';

// Moderation config
const BAD_WORDS = ['anjing', 'bangsat', 'kontol', 'memek'];
const LINK_WHITELIST = ['discord.gg', 'discord.com', 'yourdomain.com'];

// Anti-spam simple tracker
const spamTracker = {}; // userId -> {count, lastTs}
const SPAM_LIMIT = 5; // messages
const SPAM_INTERVAL = 8000; // ms

// -------------------------------
// UTILITIES
// -------------------------------
function ensureUserEconomy(id) {
  if (!db.economy[id]) db.economy[id] = { coins: 0, inventory: [] };
  return db.economy[id];
}

function addCoins(id, amount) {
  const user = ensureUserEconomy(id);
  user.coins += amount;
}

function removeCoins(id, amount) {
  const user = ensureUserEconomy(id);
  if (user.coins < amount) return false;
  user.coins -= amount;
  return true;
}

function ensureLevel(id) {
  if (!db.levels[id]) db.levels[id] = { xp: 0, level: 1 };
  return db.levels[id];
}

function xpNeededFor(level) {
  return level * 100; // simple curve
}

// -------------------------------
// WELCOME + AUTO ROLE + LOG
// -------------------------------
client.on('guildMemberAdd', async (member) => {
  try {
    // auto role
    const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
    if (role) await member.roles.add(role).catch(() => {});

    // welcome channel message
    const ch = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (ch) ch.send({ content: `👋 Selamat datang **${member.user.tag}** di **${member.guild.name}**!` });

    // DM welcome
    try { await member.send(`Selamat datang di ${member.guild.name}! Baca rules ya :)`); } catch (e) {}

    // log
    const log = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (log) log.send({ content: `📥 **Join**: ${member.user.tag} (${member.id})` });
  } catch (err) {
    console.error('guildMemberAdd error', err);
  }
});

client.on('guildMemberRemove', (member) => {
  const log = member.guild.channels.cache.get(LOG_CHANNEL_ID);
  if (log) log.send({ content: `📤 **Leave**: ${member.user.tag} (${member.id})` });
});

// -------------------------------
// AUTO-MODERATION: bad words, link filter, anti-spam
// -------------------------------
client.on('messageCreate', async (m) => {
  if (m.author.bot) return;

  const msg = m.content.toLowerCase();

  // bad words
  if (BAD_WORDS.some(w => msg.includes(w))) {
    await m.delete().catch(() => {});
    m.channel.send({ content: `⚠️ **${m.author.username}**, kata-kata seperti itu tidak diperbolehkan.` });
    const log = m.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (log) log.send({ content: `🚨 Deleted bad message from ${m.author.tag}: ${m.content}` });
    return;
  }

  // link filter (simple)
  const hasLink = /https?:\/\//.test(msg) || /discord\.gg\//.test(msg);
  if (hasLink && !LINK_WHITELIST.some(k => msg.includes(k))) {
    await m.delete().catch(() => {});
    m.channel.send({ content: `🔗 Link tidak diperbolehkan di sini.` });
    const log = m.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (log) log.send({ content: `🚨 Deleted link message from ${m.author.tag}: ${m.content}` });
    return;
  }

  // basic anti-spam
  const now = Date.now();
  const st = spamTracker[m.author.id] || { count: 0, lastTs: 0 };
  if (now - st.lastTs < SPAM_INTERVAL) {
    st.count += 1;
  } else {
    st.count = 1;
  }
  st.lastTs = now;
  spamTracker[m.author.id] = st;
  if (st.count >= SPAM_LIMIT) {
    // warn and mute (attempt)
    try {
      const muteRole = m.guild.roles.cache.find(r => r.name.toLowerCase() === 'muted');
      if (muteRole) {
        const member = m.guild.members.cache.get(m.author.id);
        await member.roles.add(muteRole).catch(() => {});
        m.channel.send({ content: `🔇 ${m.author.username} telah dimute karena spam.` });
        const log = m.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (log) log.send({ content: `🔇 Muted ${m.author.tag} for spam.` });
      }
    } catch (e) { console.error('muting failed', e); }
  }

  // leveling XP
  try {
    const u = ensureLevel(m.author.id);
    u.xp += Math.floor(Math.random() * 8) + 7; // 7-14 xp
    if (u.xp >= xpNeededFor(u.level)) {
      u.xp = 0;
      u.level += 1;
      m.channel.send({ content: `🎉 **${m.author.username}** naik ke level **${u.level}**!` });

      // role reward if set
      const rewardRoleId = db.levelRewards[u.level];
      if (rewardRoleId) {
        const member = m.guild.members.cache.get(m.author.id);
        if (member) await member.roles.add(rewardRoleId).catch(() => {});
      }
    }
  } catch (e) { console.error('leveling err', e); }
});

client.on('messageDelete', (message) => {
  const log = message.guild?.channels.cache.get(LOG_CHANNEL_ID);
  if (log) log.send({ content: `🗑️ Message deleted from ${message.author?.tag || 'Unknown'}: ${message.content || '[embed/attachment]'}` });
});

// -------------------------------
// REACTION ROLE (panel)
// -------------------------------
// This creates a simple message with a select menu to choose roles.
async function postReactionRolePanel(guild) {
  const ch = guild.channels.cache.get(REACTION_ROLE_CHANNEL_ID);
  if (!ch) return;

  const menu = new StringSelectMenuBuilder()
    .setCustomId('role_select')
    .setPlaceholder('Pilih role...')
    .addOptions([
      { label: 'Role A', value: 'ROLE_A_ID', description: 'Contoh Role A' },
      { label: 'Role B', value: 'ROLE_B_ID', description: 'Contoh Role B' }
    ]);

  const row = new ActionRowBuilder().addComponents(menu);
  const sent = await ch.send({ content: 'Pilih role di bawah ini:', components: [row] });
  return sent;
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'role_select') {
      const chosen = interaction.values; // array
      const member = interaction.guild.members.cache.get(interaction.user.id);
      // remove previous example roles
      const exampleRoles = ['ROLE_A_ID', 'ROLE_B_ID'];
      for (const r of exampleRoles) member.roles.remove(r).catch(() => {});
      for (const v of chosen) {
        await member.roles.add(v).catch(() => {});
      }
      await interaction.reply({ content: '✅ Role diperbarui.', ephemeral: true });
    }
  }

  if (interaction.isButton()) {
    // Ticket buttons
    if (interaction.customId.startsWith('ticket_')) {
      const category = interaction.customId.split('_')[1];
      const ch = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username}`,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: ['ViewChannel'] },
          { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages'] }
        ]
      });
      ch.send({ content: `Ticket dari <@${interaction.user.id}> (kategori: ${category})` });
      await interaction.reply({ content: `Ticket dibuat: ${ch}`, ephemeral: true });
      return;
    }

    // Verification button
    if (interaction.customId === 'verify_me') {
      const member = interaction.guild.members.cache.get(interaction.user.id);
      if (member) {
        await member.roles.add(VERIFIED_ROLE_ID).catch(() => {});
        await interaction.reply({ content: '✅ Sudah terverifikasi!', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ Terjadi kesalahan.', ephemeral: true });
      }
      return;
    }
  }

  // Slash commands handled below
  if (!interaction.isChatInputCommand()) return;

  // -------------------------------
  // SLASH COMMANDS: economy / leveling / admin
  // -------------------------------
  if (interaction.commandName === 'ping') return interaction.reply('Pong! 🏓');

  if (interaction.commandName === 'balance') {
    const user = ensureUserEconomy(interaction.user.id);
    return interaction.reply({ content: `💰 Saldo: **${user.coins} coin**` });
  }

  if (interaction.commandName === 'daily') {
    const last = db.dailyClaim[interaction.user.id] || 0;
    const now = Date.now();
    if (now - last < 24 * 60 * 60 * 1000) return interaction.reply({ content: '⏳ Kamu sudah claim daily hari ini.', ephemeral: true });
    addCoins(interaction.user.id, 300);
    db.dailyClaim[interaction.user.id] = now;
    return interaction.reply({ content: '🎁 Kamu mendapatkan 300 coin dari daily!' });
  }

  if (interaction.commandName === 'work') {
    const earn = Math.floor(Math.random() * 150) + 50; // 50-199
    addCoins(interaction.user.id, earn);
    return interaction.reply({ content: `💼 Kamu kerja dan mendapatkan **${earn} coin**!` });
  }

  if (interaction.commandName === 'pay') {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (!target || !amount) return interaction.reply({ content: 'Gunakan: /pay user:<user> amount:<angka>', ephemeral: true });
    if (amount <= 0) return interaction.reply({ content: 'Jumlah harus lebih dari 0', ephemeral: true });
    if (!removeCoins(interaction.user.id, amount)) return interaction.reply({ content: 'Saldo tidak cukup', ephemeral: true });
    addCoins(target.id, amount);
    return interaction.reply({ content: `✅ Berhasil transfer **${amount} coin** ke ${target.tag}` });
  }

  if (interaction.commandName === 'leaderboard') {
    const sorted = Object.entries(db.economy)
      .sort((a, b) => b[1].coins - a[1].coins)
      .slice(0, 10);
    if (!sorted.length) return interaction.reply({ content: '📉 Belum ada data leaderboard.' });
    let txt = '🏆 **Top 10 Economy**

';
    sorted.forEach(([uid, obj], idx) => { txt += `**${idx + 1}.** <@${uid}> — **${obj.coins}** coin
`; });
    return interaction.reply({ content: txt });
  }

  if (interaction.commandName === 'shop') {
    let txt = '**Shop:**
';
    db.shop.forEach(i => { txt += `• **${i.name}** — ${i.price} coin (id: ${i.id})
`; });
    return interaction.reply({ content: txt });
  }

  if (interaction.commandName === 'buy') {
    const itemId = interaction.options.getString('item');
    const item = db.shop.find(x => x.id === itemId);
    if (!item) return interaction.reply({ content: 'Item tidak ditemukan', ephemeral: true });
    if (!removeCoins(interaction.user.id, item.price)) return interaction.reply({ content: 'Saldo tidak cukup', ephemeral: true });
    const user = ensureUserEconomy(interaction.user.id);
    user.inventory.push(itemId);

    // if item is role, assign
    if (item.type === 'role' && item.meta?.roleId) {
      const member = interaction.guild.members.cache.get(interaction.user.id);
      if (member) await member.roles.add(item.meta.roleId).catch(() => {});
    }

    return interaction.reply({ content: `✅ Berhasil membeli **${item.name}**` });
  }

  if (interaction.commandName === 'inventory') {
    const user = ensureUserEconomy(interaction.user.id);
    return interaction.reply({ content: `📦 Inventory: ${user.inventory.length ? user.inventory.join(', ') : 'Kosong'}` });
  }

  if (interaction.commandName === 'gamble') {
    const amount = interaction.options.getInteger('amount');
    if (!amount || amount <= 0) return interaction.reply({ content: 'Jumlah harus > 0', ephemeral: true });
    const user = ensureUserEconomy(interaction.user.id);
    if (user.coins < amount) return interaction.reply({ content: 'Saldo tidak cukup', ephemeral: true });
    const win = Math.random() < 0.5;
    if (win) { addCoins(interaction.user.id, amount); return interaction.reply({ content: `🎉 Kamu menang! +${amount} coin` }); }
    else { removeCoins(interaction.user.id, amount); return interaction.reply({ content: `😢 Kamu kalah! -${amount} coin` }); }
  }

  if (interaction.commandName === 'level') {
    const data = db.levels[interaction.user.id] || { xp: 0, level: 1 };
    return interaction.reply({ content: `📊 Level: **${data.level}** | XP: **${data.xp}/${xpNeededFor(data.level)}**` });
  }

  // Admin: set level reward
  if (interaction.commandName === 'setlevelreward') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: 'Butuh permission Manage Roles', ephemeral: true });
    const level = interaction.options.getInteger('level');
    const role = interaction.options.getRole('role');
    if (!level || !role) return interaction.reply({ content: 'Gunakan: /setlevelreward level:<angka> role:<role>', ephemeral: true });
    db.levelRewards[level] = role.id;
    return interaction.reply({ content: `✅ Set reward role ${role.name} for level ${level}` });
  }

  // Admin: post reaction role panel
  if (interaction.commandName === 'postreactionpanel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Butuh permission Manage Guild', ephemeral: true });
    await postReactionRolePanel(interaction.guild);
    return interaction.reply({ content: '✅ Reaction role panel posted', ephemeral: true });
  }

  // Admin: post ticket panel
  if (interaction.commandName === 'postticketpanel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Butuh permission Manage Guild', ephemeral: true });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_billing').setLabel('Billing').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ticket_support').setLabel('Support').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket_other').setLabel('Other').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ content: 'Klik tombol untuk buat ticket:', components: [row] });
    return;
  }

  // Admin: post verification panel
  if (interaction.commandName === 'postverifypanel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Butuh permission Manage Guild', ephemeral: true });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_me').setLabel('Verify').setStyle(ButtonStyle.Success)
    );
    await interaction.reply({ content: 'Klik Verify untuk mendapatkan akses ke server', components: [row] });
    return;
  }

});

// -------------------------------
// SLASH COMMAND REGISTRATION
// -------------------------------
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Cek ping bot'),
  new SlashCommandBuilder().setName('balance').setDescription('Cek saldo kamu'),
  new SlashCommandBuilder().setName('daily').setDescription('Claim daily coin'),
  new SlashCommandBuilder().setName('work').setDescription('Kerja dapat coin'),
  new SlashCommandBuilder().setName('pay').setDescription('Transfer coin ke user').addUserOption(opt => opt.setName('user').setDescription('User tujuan').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah').setRequired(true)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Lihat top coin'),
  new SlashCommandBuilder().setName('shop').setDescription('Lihat shop'),
  new SlashCommandBuilder().setName('buy').setDescription('Beli item').addStringOption(opt => opt.setName('item').setDescription('Item id').setRequired(true)),
  new SlashCommandBuilder().setName('inventory').setDescription('Lihat inventory'),
  new SlashCommandBuilder().setName('gamble').setDescription('Bertaruh coin').addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah').setRequired(true)),
  new SlashCommandBuilder().setName('level').setDescription('Lihat level kamu'),
  new SlashCommandBuilder().setName('setlevelreward').setDescription('Set level -> role reward').addIntegerOption(o => o.setName('level').setDescription('Level').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  new SlashCommandBuilder().setName('postreactionpanel').setDescription('Post reaction role panel'),
  new SlashCommandBuilder().setName('postticketpanel').setDescription('Post ticket panel'),
  new SlashCommandBuilder().setName('postverifypanel').setDescription('Post verification panel')
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
async function registerSlash() {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Slash commands registered');
  } catch (e) { console.error('Failed to register slash', e); }
}

// -------------------------------
// READY
// -------------------------------
client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

registerSlash();
client.login(process.env.TOKEN);
