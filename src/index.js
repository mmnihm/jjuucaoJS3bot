'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.env.BOT_TOKEN;
const BOT_NAME = process.env.BOT_NAME || '会员通知助手';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const POLL_TIMEOUT = Math.max(5, Math.min(50, Number(process.env.POLL_TIMEOUT || 25)));

if (!TOKEN) {
  console.error('启动失败：缺少唯一必需环境变量 BOT_TOKEN');
  process.exit(1);
}

const API = 'https://api.telegram.org/bot' + TOKEN;
let offset = 0;
let state = {
  adminId: null,
  users: {},
  buttons: [],
  supportMode: {},
  supportMap: {},
  pendingBroadcast: {},
  pendingButtonEdit: {},
  welcomeMessage: '',
  pendingWelcomeEdit: {},
  buttonColumns: 2
};

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...state, ...saved };
    } else {
      saveState();
    }
  } catch (err) {
    console.error('读取数据失败：' + err.message);
    throw err;
  }
  state.users ||= {};
  state.buttons = (state.buttons || []).filter(item => !['会员套餐', '最新通知', '联系客服'].includes(item.name));
  state.supportMode ||= {};
  state.supportMap ||= {};
  state.pendingBroadcast ||= {};
  state.pendingButtonEdit ||= {};
  state.pendingWelcomeEdit ||= {};
  state.welcomeMessage ||= '';
  state.buttonColumns = Math.max(1, Math.min(4, Number(state.buttonColumns) || 2));
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = STATE_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, STATE_FILE);
  } catch (err) {
    console.error('保存数据失败：' + err.message);
  }
}

async function api(method, payload = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(API + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json();
    if (!data.ok) {
      const error = new Error(data.description || ('Telegram API ' + method + ' failed'));
      error.code = data.error_code;
      error.parameters = data.parameters || {};
      throw error;
    }
    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendMessage(chatId, text, extra = {}) {
  return api('sendMessage', {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    ...extra
  });
}

async function copyMessage(chatId, fromChatId, messageId, extra = {}) {
  return api('copyMessage', {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra
  });
}

function isAdmin(userId) {
  return state.adminId !== null && String(userId) === String(state.adminId);
}

function keyboard(userId) {
  const rows = [];
  const custom = state.buttons.map(item => item.name).filter(name => !['⚙️ 设置', '/admin'].includes(name));
  custom.push('联系客服');
  const columns = Math.max(1, Math.min(4, Number(state.buttonColumns) || 2));
  for (let i = 0; i < custom.length; i += columns) rows.push(custom.slice(i, i + columns));
  if (isAdmin(userId)) rows.push(['⚙️ 设置']);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

async function home(chatId, userId, text) {
  await sendMessage(chatId, text, { reply_markup: keyboard(userId) });
}

async function adminHelp(chatId) {
  await sendMessage(chatId, [
    '管理员功能：',
    '也可以点击底部「⚙️ 设置」打开管理菜单。',
    '/buttons — 查看自定义按钮',
    '/addbutton 按钮名称|自动回复内容|链接 — 新增或修改按钮',
    '/delbutton 按钮名称 — 删除按钮',
    '/broadcast — 编写广播并二次确认',
    '/cancel — 取消当前操作',
    '',
    '客服：直接回复转发给你的用户消息，即可回复用户。',
    '首次使用提示：第一个发送 /start 的用户会自动成为管理员。'
  ].join('\n'), { reply_markup: keyboard(state.adminId) });
}

function commandOf(text) {
  return (String(text || '').trim().split(/\s+/, 1)[0] || '').split('@')[0].toLowerCase();
}

async function handleAdminCommand(msg, command, text) {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return false;

  if (command === '/admin') {
    await adminHelp(chatId);
    return true;
  }

  if (command === '/buttons') {
    const list = state.buttons.length
      ? state.buttons.map((b, i) => (i + 1) + '. ' + b.name + ' → ' + b.reply).join('\n')
      : '目前没有自定义按钮。';
    await sendMessage(chatId, '自定义按钮：\n' + list, { reply_markup: keyboard(msg.from.id) });
    return true;
  }

  if (command === '/addbutton') {
    const value = text.replace(/^\/addbutton(?:@\S+)?\s*/i, '');
    const parts = value.split('|');
    const name = (parts.shift() || '').trim().slice(0, 40);
    const reply = (parts.shift() || '').trim().slice(0, 3500);
    const url = (parts.join('|') || '').trim();
    if (!name || (!reply && !url)) {
      await sendMessage(chatId, '格式：/addbutton 按钮名称|自动回复内容|链接\n例如：/addbutton 会员频道|点击下方进入频道|https://t.me/yourchannel');
      return true;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      await sendMessage(chatId, '链接必须以 https:// 或 http:// 开头。');
      return true;
    }
    if (['⚙️ 设置', '/admin'].includes(name)) {
      await sendMessage(chatId, '这个名称是固定菜单，请换一个按钮名称。');
      return true;
    }
    const existing = state.buttons.findIndex(item => item.name === name);
    if (existing >= 0) state.buttons[existing] = { ...state.buttons[existing], name, reply, url: url || state.buttons[existing].url || '' };
    else if (state.buttons.length >= 16) {
      await sendMessage(chatId, '自定义按钮最多 16 个，请先删除不需要的按钮。');
      return true;
    } else state.buttons.push({ name, reply, url });
    saveState();
    await sendMessage(chatId, '已保存按钮“' + name + '”。', { reply_markup: keyboard(msg.from.id) });
    return true;
  }

  if (command === '/delbutton') {
    const name = text.replace(/^\/delbutton(?:@\S+)?\s*/i, '').trim();
    const before = state.buttons.length;
    state.buttons = state.buttons.filter(item => item.name !== name);
    saveState();
    await sendMessage(chatId, before === state.buttons.length ? '没有找到这个按钮。' : '已删除按钮“' + name + '”。', {
      reply_markup: keyboard(msg.from.id)
    });
    return true;
  }

  if (command === '/broadcast') {
    state.pendingBroadcast[String(msg.from.id)] = { stage: 'draft', text: '' };
    saveState();
    await sendMessage(chatId, '请发送要广播的纯文本公告。发送后还会让你二次确认。输入 /cancel 可取消。');
    return true;
  }

  if (command === '/cancel') {
    delete state.pendingBroadcast[String(msg.from.id)];
    delete state.pendingButtonEdit[String(msg.from.id)];
    state.supportMode[String(msg.from.id)] = false;
    saveState();
    await sendMessage(chatId, '已取消当前操作。', { reply_markup: keyboard(msg.from.id) });
    return true;
  }

  return false;
}

async function runBroadcast(adminChatId, text, buttons = []) {
  let success = 0;
  let failed = 0;
  const ids = Object.keys(state.users);
  for (const id of ids) {
    const extra = buttons.length
      ? { reply_markup: { inline_keyboard: buttons.map(button => [{ text: button.name, url: button.url }]) } }
      : { reply_markup: keyboard(Number(id)) };
    try {
      await sendMessage(id, text, extra);
      success++;
    } catch (err) {
      failed++;
      if (err.code === 429 && Number(err.parameters?.retry_after) > 0) {
        await new Promise(resolve => setTimeout(resolve, (Number(err.parameters.retry_after) + 1) * 1000));
        try {
          await sendMessage(id, text, extra);
          failed--;
          success++;
        } catch {}
      }
      console.warn('广播发送失败，用户 ' + id + '：' + err.message);
    }
    await new Promise(resolve => setTimeout(resolve, 45));
  }
  await sendMessage(adminChatId, '广播完成。\n成功：' + success + '\n失败：' + failed, {
    reply_markup: keyboard(state.adminId)
  });
}

async function handleSupportReply(msg) {
  if (!isAdmin(msg.from.id) || !msg.reply_to_message) return false;
  const target = state.supportMap[String(msg.reply_to_message.message_id)];
  if (!target) return false;
  try {
    await copyMessage(target, msg.chat.id, msg.message_id);
    await sendMessage(msg.chat.id, '已回复用户。');
  } catch (err) {
    await sendMessage(msg.chat.id, '回复失败：' + err.message);
  }
  return true;
}

async function forwardToAdmin(msg) {
  const uid = String(msg.from.id);
  const label = '📩 客服消息\n姓名：' + (msg.from.first_name || '未设置') +
    (msg.from.username ? ' (@' + msg.from.username + ')' : '') +
    '\n用户 ID：' + msg.from.id;
  const header = await sendMessage(state.adminId, label);
  const copied = await copyMessage(state.adminId, msg.chat.id, msg.message_id, {
    reply_to_message_id: header.message_id
  });
  state.supportMap[String(copied.message_id)] = uid;
  saveState();
}

async function handleMessage(msg) {
  if (!msg?.chat || !msg?.from || msg.chat.type !== 'private') return;
  const uid = String(msg.from.id);
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  const command = commandOf(text);

  // First user to send /start claims the admin role; save it to disk.
  let becameAdmin = false;
  if (command === '/start' && state.adminId === null) {
    state.adminId = msg.from.id;
    becameAdmin = true;
    console.log('首位 /start 用户成为管理员：' + state.adminId);
  }

  const now = Date.now();
  const previousUser = state.users[uid];
  state.users[uid] = {
    id: msg.from.id,
    first_name: msg.from.first_name || '',
    username: msg.from.username || '',
    first_seen: previousUser?.first_seen || now,
    start_counted: previousUser ? (previousUser.start_counted || null) : (command === '/start' ? now : null),
    last_seen: now
  };
  saveState();

  if (await handleSupportReply(msg)) return;

  if (command === '/start') {
    state.supportMode[uid] = false;
    saveState();
    const defaultGreeting = '欢迎使用' + BOT_NAME + '！\n\n请使用下方菜单查看信息或联系客服。';
    const greeting = (becameAdmin
      ? '你是第一个启动机器人的用户，已自动成为管理员。\n发送 /admin 管理机器人。\n\n'
      : '') + (state.welcomeMessage || defaultGreeting);
    await home(msg.chat.id, msg.from.id, greeting);
    return;
  }

  if (command === '/help') {
    await sendMessage(msg.chat.id, '请点击下方菜单使用功能。如需人工帮助，请点击“联系客服”。', {
      reply_markup: keyboard(msg.from.id)
    });
    return;
  }

  if (isAdmin(msg.from.id) && command && await handleAdminCommand(msg, command, text)) return;

  if (isAdmin(msg.from.id) && state.pendingWelcomeEdit[uid]) {
    if (command === '/cancel') {
      delete state.pendingWelcomeEdit[uid];
      saveState();
      await sendMessage(msg.chat.id, '已取消欢迎消息修改。', { reply_markup: keyboard(msg.from.id) });
      return;
    }
    if (!text) {
      await sendMessage(msg.chat.id, '请发送文字欢迎消息，或发送 /cancel 取消。');
      return;
    }
    state.welcomeMessage = text === '/reset' ? '' : text.slice(0, 3500);
    delete state.pendingWelcomeEdit[uid];
    saveState();
    await sendMessage(msg.chat.id, state.welcomeMessage ? '新用户欢迎消息已保存。发送 /start 可预览。' : '已恢复默认欢迎消息。', { reply_markup: keyboard(msg.from.id) });
    return;
  }

  if (isAdmin(msg.from.id) && state.pendingButtonEdit[uid]) {
    const edit = state.pendingButtonEdit[uid];
    const button = state.buttons[edit.index];
    delete state.pendingButtonEdit[uid];
    if (!button) {
      saveState();
      await sendMessage(msg.chat.id, '这个按钮已不存在，请重新打开设置。', { reply_markup: keyboard(msg.from.id) });
      return;
    }
    if (!text || command.startsWith('/')) {
      await sendMessage(msg.chat.id, '请输入有效内容，或发送 /cancel 取消。');
      state.pendingButtonEdit[uid] = edit;
      saveState();
      return;
    }
    if (edit.action === 'name') {
      if (['⚙️ 设置', '/admin'].includes(text) ||
          state.buttons.some((item, index) => index !== edit.index && item.name === text)) {
        state.pendingButtonEdit[uid] = edit;
        saveState();
        await sendMessage(msg.chat.id, '名称已被占用或属于固定菜单，请重新输入，或发送 /cancel 取消。');
        return;
      }
      button.name = text.slice(0, 40);
    } else if (edit.action === 'url') {
      if (text !== '-' && !/^https?:\/\//i.test(text)) {
        state.pendingButtonEdit[uid] = edit;
        saveState();
        await sendMessage(msg.chat.id, '请输入以 https:// 或 http:// 开头的链接；发送 - 可清除链接，/cancel 可取消。');
        return;
      }
      button.url = text === '-' ? '' : text.slice(0, 1000);
    } else if (edit.action === 'reply') {
      button.reply = text.slice(0, 3500);
    }
    saveState();
    await sendMessage(msg.chat.id, '已更新按钮设置。', { reply_markup: keyboard(msg.from.id) });
    return;
  }

  if (isAdmin(msg.from.id)) {
    const pending = state.pendingBroadcast[uid];
    if (pending?.stage === 'draft') {
      if (!text || command.startsWith('/')) {
        await sendMessage(msg.chat.id, '请发送纯文本公告内容，或发送 /cancel 取消。');
        return;
      }
      pending.text = text;
      pending.buttons = [];
      pending.stage = 'buttons';
      saveState();
      await sendMessage(msg.chat.id, '公告内容已收到。\n\n如需在公告下方添加内联按钮，请发送：按钮名称|完整链接\n例如：加入会员群|https://t.me/yourchannel\n可以连续添加多个按钮，最多 8 个。\n发送 /done 完成按钮设置，/skip 不添加按钮，/cancel 取消广播。');
      return;
    }
    if (pending?.stage === 'buttons') {
      if (command === '/skip' || command === '/done') {
        pending.stage = 'confirm';
        saveState();
        const rows = (pending.buttons || []).map(button => [{ text: button.name, url: button.url }]);
        rows.push([
          { text: '✅ 确认广播', callback_data: 'broadcast:confirm' },
          { text: '❌ 取消广播', callback_data: 'broadcast:cancel' }
        ]);
        await sendMessage(msg.chat.id, '📢 广播预览\n\n' + pending.text + '\n\n' +
          ((pending.buttons || []).length ? '已添加 ' + pending.buttons.length + ' 个内联按钮。' : '未添加内联按钮。') +
          '\n请确认后发送给所有用户。', { reply_markup: { inline_keyboard: rows } });
        return;
      }
      const parts = text.split('|');
      const name = (parts.shift() || '').trim().slice(0, 64);
      const url = parts.join('|').trim();
      if (!name || !/^https?:\/\//i.test(url)) {
        await sendMessage(msg.chat.id, '格式不正确。请发送：按钮名称|https://完整链接\n例如：加入会员群|https://t.me/yourchannel\n发送 /done 完成，/skip 不添加按钮，/cancel 取消。');
        return;
      }
      if ((pending.buttons || []).length >= 8) {
        await sendMessage(msg.chat.id, '最多添加 8 个内联按钮。发送 /done 完成设置。');
        return;
      }
      pending.buttons ||= [];
      pending.buttons.push({ name, url });
      saveState();
      await sendMessage(msg.chat.id, '已添加内联按钮「' + name + '」。\n继续发送“按钮名称|链接”添加更多，或发送 /done 完成，/cancel 取消。');
      return;
    }
  }

  if (text === '⚙️ 设置' && isAdmin(msg.from.id)) {
    await sendMessage(msg.chat.id, '⚙️ 管理员设置\n请选择要管理的项目：', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '管理自定义按钮', callback_data: 'settings:buttons' }],
          [{ text: '设置底部每行按钮数', callback_data: 'settings:layout' }],
          [{ text: '设置新用户欢迎消息', callback_data: 'settings:welcome' }],
          [{ text: '添加/修改按钮', callback_data: 'settings:addbutton' }],
          [{ text: '📊 用户统计', callback_data: 'settings:stats' }],
          [{ text: '开始广播', callback_data: 'settings:broadcast' }],
          [{ text: '管理帮助', callback_data: 'settings:help' }]
        ]
      }
    });
    return;
  }

  if (text === '联系客服') {
    state.supportMode[uid] = true;
    saveState();
    await sendMessage(msg.chat.id, '请直接发送要咨询的内容或文件，我会转发给管理员。发送 /cancel 可退出客服咨询。', {
      reply_markup: keyboard(msg.from.id)
    });
    return;
  }

  if (state.supportMode[uid] && command === '/cancel') {
    state.supportMode[uid] = false;
    saveState();
    await sendMessage(msg.chat.id, '已退出客服咨询。', { reply_markup: keyboard(msg.from.id) });
    return;
  }

  if (state.supportMode[uid]) {
    if (state.adminId === null) {
      await sendMessage(msg.chat.id, '管理员尚未初始化，请稍后再试。');
      return;
    }
    try {
      await forwardToAdmin(msg);
      await sendMessage(msg.chat.id, '已转交管理员，请等待回复。', { reply_markup: keyboard(msg.from.id) });
    } catch (err) {
      console.error('客服转发失败：' + err.message);
      await sendMessage(msg.chat.id, '转发失败，请稍后重试。');
    }
    return;
  }

  const custom = state.buttons.find(item => item.name === text);
  if (custom) {
    if (custom.url) {
      await sendMessage(msg.chat.id, custom.reply || '请点击下方按钮打开链接：', {
        reply_markup: { inline_keyboard: [[{ text: '🔗 打开 ' + custom.name, url: custom.url }]] }
      });
    } else {
      await sendMessage(msg.chat.id, custom.reply, { reply_markup: keyboard(msg.from.id) });
    }
    return;
  }

  if (msg.from.id !== state.adminId && !text.startsWith('/')) {
    await sendMessage(msg.chat.id, '已收到你的消息。请使用下方菜单，或点击“联系客服”联系管理员。', {
      reply_markup: keyboard(msg.from.id)
    });
  }
}

async function handleCallback(query) {
  try {
    await api('answerCallbackQuery', { callback_query_id: query.id });
  } catch (err) {
    console.warn('回调确认失败：' + err.message);
  }

  if (!isAdmin(query.from.id)) return;
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  const key = String(query.from.id);
  const pending = state.pendingBroadcast[key];

  if (query.data === 'settings:help') {
    await adminHelp(chatId);
    return;
  }

  if (query.data === 'settings:layout') {
    await sendMessage(chatId, '请选择底部每行显示几个按钮（当前：' + state.buttonColumns + ' 个）：', {
      reply_markup: { inline_keyboard: [
        [{ text: '1 个/行' + (state.buttonColumns === 1 ? ' ✓' : ''), callback_data: 'settings:layout:1' },
         { text: '2 个/行' + (state.buttonColumns === 2 ? ' ✓' : ''), callback_data: 'settings:layout:2' }],
        [{ text: '3 个/行' + (state.buttonColumns === 3 ? ' ✓' : ''), callback_data: 'settings:layout:3' },
         { text: '4 个/行' + (state.buttonColumns === 4 ? ' ✓' : ''), callback_data: 'settings:layout:4' }],
        [{ text: '⬅️ 返回设置', callback_data: 'settings:menu' }]
      ] }
    });
    return;
  }

  const layoutMatch = query.data.match(/^settings:layout:([1-4])$/);
  if (layoutMatch) {
    state.buttonColumns = Number(layoutMatch[1]);
    saveState();
    await sendMessage(chatId, '已设置为每行 ' + state.buttonColumns + ' 个按钮。发送 /start 刷新底部菜单。', {
      reply_markup: { inline_keyboard: [[{ text: '重新选择', callback_data: 'settings:layout' }], [{ text: '返回设置', callback_data: 'settings:menu' }]] }
    });
    return;
  }

  if (query.data === 'settings:welcome') {
    state.pendingWelcomeEdit[key] = true;
    saveState();
    await sendMessage(chatId, '请发送新用户启动机器人时显示的欢迎消息。\n可以直接换行排版。\n发送 /reset 恢复默认欢迎消息，发送 /cancel 取消修改。');
    return;
  }

  if (query.data === 'settings:addbutton') {
    await sendMessage(chatId, '请发送以下格式新增或修改按钮：\n/addbutton 按钮名称|自动回复内容|链接\n\n例如：\n/addbutton 会员频道|点击下方进入频道|https://t.me/yourchannel\n\n没有链接时，最后一项可以省略。');
    return;
  }

  if (query.data === 'settings:broadcast') {
    state.pendingBroadcast[key] = { stage: 'draft', text: '' };
    saveState();
    await sendMessage(chatId, '请发送要广播的纯文本公告。发送后还会让你二次确认。输入 /cancel 可取消。');
    return;
  }

  if (query.data === 'settings:buttons') {
    const rows = [];
    const editable = state.buttons.map((button, index) => ({ button, index }))
      .filter(({ button }) => !['⚙️ 设置', '/admin'].includes(button.name));
    if (editable.length) {
      editable.forEach(({ button, index }) => {
        rows.push([{ text: '✏️ 名称：' + button.name, callback_data: 'settings:editname:' + index }]);
        rows.push([{ text: '🔗 链接：' + (button.url ? '已设置' : '未设置'), callback_data: 'settings:editurl:' + index }]);
        rows.push([{ text: '📝 回复内容：' + button.name, callback_data: 'settings:editreply:' + index }]);
        rows.push([{ text: '🗑 删除：' + button.name, callback_data: 'settings:del:' + index }]);
      });
    } else {
      rows.push([{ text: '暂无自定义按钮', callback_data: 'settings:noop' }]);
    }
    rows.push([{ text: '➕ 添加按钮', callback_data: 'settings:addbutton' }]);
    rows.push([{ text: '⬅️ 返回设置', callback_data: 'settings:menu' }]);
    const details = editable.length
      ? editable.map(({ button }, index) => (index + 1) + '. ' + button.name + '\n链接：' + (button.url || '未设置') + '\n回复：' + (button.reply || '无')).join('\n\n')
      : '目前没有自定义按钮。';
    await sendMessage(chatId, '自定义按钮管理：\n' + details + '\n\n点击对应操作可单独修改名称、链接或回复内容。', {
      reply_markup: { inline_keyboard: rows }
    });
    return;
  }

  if (query.data === 'settings:menu') {
    await sendMessage(chatId, '⚙️ 管理员设置\n请选择要管理的项目：', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '管理自定义按钮', callback_data: 'settings:buttons' }],
          [{ text: '添加/修改按钮', callback_data: 'settings:addbutton' }],
          [{ text: '📊 用户统计', callback_data: 'settings:stats' }],
          [{ text: '开始广播', callback_data: 'settings:broadcast' }],
          [{ text: '管理帮助', callback_data: 'settings:help' }]
        ]
      }
    });
    return;
  }

  if (query.data === 'settings:stats') {
    const users = Object.values(state.users || {});
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
    const started = users.filter(user => Number(user.start_counted) > 0);
    const today = started.filter(user => Number(user.start_counted) >= todayStart).length;
    const week = started.filter(user => Number(user.start_counted) >= weekStart).length;
    const unknownHistory = users.length - started.length;
    const message = '📊 用户统计\\n\\n' +
      '本次更新后记录的启动用户：' + started.length + ' 人\\n' +
      '已记录用户总数：' + users.length + ' 人\\n' +
      '今日首次启动：' + today + ' 人\\n' +
      '最近 7 天首次启动：' + week + ' 人' +
      (unknownHistory ? '\\n\\n旧用户的历史启动时间未记录：' + unknownHistory + ' 人（不计入今日和近 7 天）' : '');
    await sendMessage(chatId, message, {
      reply_markup: { inline_keyboard: [[{ text: '🔄 刷新统计', callback_data: 'settings:stats' }], [{ text: '⬅️ 返回设置', callback_data: 'settings:menu' }]] }
    });
    return;
  }

  if (query.data === 'settings:noop') return;

  const editMatch = query.data.match(/^settings:edit(name|url|reply):(\d+)$/);
  if (editMatch) {
    const action = editMatch[1];
    const index = Number(editMatch[2]);
    const button = state.buttons[index];
    if (!button || ['⚙️ 设置', '/admin'].includes(button.name)) {
      await sendMessage(chatId, '这个按钮不可编辑或已不存在，请重新打开设置菜单。');
      return;
    }
    state.pendingButtonEdit[key] = { action, index };
    saveState();
    const prompts = {
      name: '请输入按钮的新名称：',
      url: '请输入新的完整链接（以 https:// 或 http:// 开头）；发送 - 可清除链接：',
      reply: '请输入新的回复内容：'
    };
    await sendMessage(chatId, '正在修改「' + button.name + '」。\n' + prompts[action] + '\n发送 /cancel 可取消。');
    return;
  }

  if (query.data.startsWith('settings:del:')) {
    const index = Number(query.data.slice('settings:del:'.length));
    if (!Number.isInteger(index) || index < 0 || index >= state.buttons.length) {
      await sendMessage(chatId, '这个按钮可能已被删除，请重新打开设置菜单。');
      return;
    }
    const name = state.buttons[index].name;
    if (['⚙️ 设置', '/admin'].includes(name)) {
      await sendMessage(chatId, '固定菜单不能从自定义按钮管理中删除。');
      return;
    }
    state.buttons.splice(index, 1);
    saveState();
    await sendMessage(chatId, '已删除按钮「' + name + '」。', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '继续管理按钮', callback_data: 'settings:buttons' }],
          [{ text: '返回设置', callback_data: 'settings:menu' }]
        ]
      }
    });
    return;
  }

  if (query.data === 'broadcast:cancel') {
    delete state.pendingBroadcast[key];
    saveState();
    await sendMessage(chatId, '已取消广播。', { reply_markup: keyboard(query.from.id) });
    return;
  }

  if (query.data === 'broadcast:confirm') {
    if (!pending || pending.stage !== 'confirm' || !pending.text) {
      await sendMessage(chatId, '没有待确认的广播，请重新执行 /broadcast。');
      return;
    }
    const text = pending.text;
    const buttons = Array.isArray(pending.buttons) ? pending.buttons.slice() : [];
    delete state.pendingBroadcast[key];
    saveState();
    await sendMessage(chatId, '已开始广播' + (buttons.length ? '（含 ' + buttons.length + ' 个内联按钮）' : '') + '，完成后会发送统计结果。', { reply_markup: keyboard(query.from.id) });
    // Do not block update polling while broadcasting.
    runBroadcast(chatId, text, buttons).catch(err => console.error('广播异常：' + err.message));
  }
}

async function poll() {
  while (true) {
    try {
      const updates = await api('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message', 'callback_query']
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(update.message);
          else if (update.callback_query) await handleCallback(update.callback_query);
        } catch (err) {
          console.error('处理更新失败：' + err.message);
          const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          if (chatId) {
            try { await sendMessage(chatId, '操作失败，请稍后重试。'); } catch {}
          }
        }
      }
    } catch (err) {
      console.error('轮询异常，5 秒后重试：' + err.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

loadState();
console.log(BOT_NAME + ' 已启动。只需设置 BOT_TOKEN；首位 /start 用户自动成为管理员。');
poll();
