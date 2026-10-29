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
  buttons: [
    { name: '会员套餐', reply: '请查看会员套餐公告。如需咨询，请点击“联系客服”。' },
    { name: '最新通知', reply: '请查看会员频道或会员群内的最新通知。' }
  ],
  supportMode: {},
  supportMap: {},
  pendingBroadcast: {}
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
  state.buttons ||= [];
  state.supportMode ||= {};
  state.supportMap ||= {};
  state.pendingBroadcast ||= {};
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
  const fixed = ['会员套餐', '最新通知', '联系客服'];
  const rows = [[fixed[0], fixed[1]], [fixed[2]]];
  const custom = state.buttons.map(item => item.name).filter(name => !fixed.includes(name));
  for (let i = 0; i < custom.length; i += 2) rows.push(custom.slice(i, i + 2));
  if (isAdmin(userId)) rows.push(['/admin']);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

async function home(chatId, userId, text) {
  await sendMessage(chatId, text, { reply_markup: keyboard(userId) });
}

async function adminHelp(chatId) {
  await sendMessage(chatId, [
    '管理员功能：',
    '/buttons — 查看自定义按钮',
    '/addbutton 按钮名称|自动回复内容 — 新增或修改按钮',
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
    const split = value.indexOf('|');
    if (split < 1 || !value.slice(0, split).trim() || !value.slice(split + 1).trim()) {
      await sendMessage(chatId, '格式：/addbutton 按钮名称|自动回复内容\n例如：/addbutton 会员价格|请联系客服了解套餐。');
      return true;
    }
    const name = value.slice(0, split).trim().slice(0, 40);
    const reply = value.slice(split + 1).trim().slice(0, 3500);
    if (['会员套餐', '最新通知', '联系客服', '/admin'].includes(name)) {
      await sendMessage(chatId, '这个名称是固定菜单，请换一个按钮名称。');
      return true;
    }
    const existing = state.buttons.findIndex(item => item.name === name);
    if (existing >= 0) state.buttons[existing] = { name, reply };
    else if (state.buttons.length >= 16) {
      await sendMessage(chatId, '自定义按钮最多 16 个，请先删除不需要的按钮。');
      return true;
    } else state.buttons.push({ name, reply });
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
    state.supportMode[String(msg.from.id)] = false;
    saveState();
    await sendMessage(chatId, '已取消当前操作。', { reply_markup: keyboard(msg.from.id) });
    return true;
  }

  return false;
}

async function runBroadcast(adminChatId, text) {
  let success = 0;
  let failed = 0;
  const ids = Object.keys(state.users);
  for (const id of ids) {
    try {
      await sendMessage(id, text, { reply_markup: keyboard(Number(id)) });
      success++;
    } catch (err) {
      failed++;
      if (err.code === 429 && Number(err.parameters?.retry_after) > 0) {
        await new Promise(resolve => setTimeout(resolve, (Number(err.parameters.retry_after) + 1) * 1000));
        try {
          await sendMessage(id, text, { reply_markup: keyboard(Number(id)) });
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

  state.users[uid] = {
    id: msg.from.id,
    first_name: msg.from.first_name || '',
    username: msg.from.username || '',
    last_seen: Date.now()
  };
  saveState();

  if (await handleSupportReply(msg)) return;

  if (command === '/start') {
    state.supportMode[uid] = false;
    saveState();
    const greeting = (becameAdmin
      ? '你是第一个启动机器人的用户，已自动成为管理员。\n发送 /admin 管理机器人。\n\n'
      : '') + '欢迎使用' + BOT_NAME + '！\n\n请使用下方菜单查看信息或联系客服。';
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

  if (isAdmin(msg.from.id)) {
    const pending = state.pendingBroadcast[uid];
    if (pending && pending.stage === 'draft') {
      if (!text || command.startsWith('/')) {
        await sendMessage(msg.chat.id, '请发送纯文本公告，或输入 /cancel 取消。');
        return;
      }
      pending.stage = 'confirm';
      pending.text = text.slice(0, 4000);
      saveState();
      await sendMessage(msg.chat.id, '请确认广播内容：\n\n' + pending.text.slice(0, 3500), {
        reply_markup: {
          inline_keyboard: [[
            { text: '确认广播', callback_data: 'broadcast:confirm' },
            { text: '取消广播', callback_data: 'broadcast:cancel' }
          ]]
        }
      });
      return;
    }
  }

  if (text === '联系客服') {
    state.supportMode[uid] = true;
    saveState();
    await sendMessage(msg.chat.id, '请直接发送要咨询的内容或文件，我会转发给管理员。发送 /cancel 可退出。', {
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

  if (text === '会员套餐') {
    await sendMessage(msg.chat.id, '请查看会员套餐公告。如需咨询价格和权益，请点击“联系客服”。', {
      reply_markup: keyboard(msg.from.id)
    });
    return;
  }

  if (text === '最新通知') {
    await sendMessage(msg.chat.id, '请查看会员频道或会员群内的最新通知。', {
      reply_markup: keyboard(msg.from.id)
    });
    return;
  }

  const custom = state.buttons.find(item => item.name === text);
  if (custom) {
    await sendMessage(msg.chat.id, custom.reply, { reply_markup: keyboard(msg.from.id) });
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
    delete state.pendingBroadcast[key];
    saveState();
    await sendMessage(chatId, '已开始广播，完成后会发送统计结果。', { reply_markup: keyboard(query.from.id) });
    // Do not block update polling while broadcasting.
    runBroadcast(chatId, text).catch(err => console.error('广播异常：' + err.message));
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
