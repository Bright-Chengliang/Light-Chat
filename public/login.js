const form = document.querySelector('#loginForm');
const usernameInput = document.querySelector('#usernameInput');
const passwordInput = document.querySelector('#passwordInput');
const rememberInput = document.querySelector('#rememberLoginInput');
const status = document.querySelector('#loginStatus');
const button = document.querySelector('#loginButton');
const guestButton = document.querySelector('#guestButton');
const REMEMBERED_USERNAME_KEY = 'light-chat:remembered-username';

let csrf = '';

try {
  const rememberedUsername = localStorage.getItem(REMEMBERED_USERNAME_KEY);
  if (rememberedUsername) {
    usernameInput.value = rememberedUsername;
    rememberInput.checked = true;
  }
} catch {}

async function bootstrap() {
  try {
    const response = await fetch('/api/login/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.csrf) throw new Error(payload.error || '无法建立安全会话');
    csrf = payload.csrf;
    status.textContent = '请输入登录凭据';
    status.classList.remove('error');
    button.disabled = false;
    guestButton.disabled = false;
  } catch {
    status.textContent = '安全会话建立失败，请刷新页面重试';
    status.classList.add('error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!csrf || !usernameInput.value.trim() || !passwordInput.value) return;
  button.disabled = true;
  status.textContent = '正在验证…';
  status.classList.remove('error');
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ username: usernameInput.value.trim(), password: passwordInput.value, remember: rememberInput.checked }),
    });
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 403) await bootstrap();
      throw new Error(payload.error || '登录失败');
    }
    try {
      if (rememberInput.checked) localStorage.setItem(REMEMBERED_USERNAME_KEY, usernameInput.value.trim());
      else localStorage.removeItem(REMEMBERED_USERNAME_KEY);
    } catch {}
    status.textContent = '验证成功，正在进入…';
    location.replace('/app');
  } catch (error) {
    passwordInput.value = '';
    passwordInput.focus();
    status.textContent = error.message || '登录失败';
    status.classList.add('error');
    button.disabled = !csrf;
  }
});

guestButton.addEventListener('click', async () => {
  if (!csrf) return;
  guestButton.disabled = true;
  status.textContent = '正在进入游客模式…';
  status.classList.remove('error');
  try {
    const response = await fetch('/api/auth/guest', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{}',
    });
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 403) await bootstrap();
      throw new Error(payload.error || '游客模式开启失败');
    }
    status.textContent = '已进入游客模式，正在打开工作台…';
    location.replace('/app');
  } catch (error) {
    status.textContent = error.message || '游客模式开启失败';
    status.classList.add('error');
    guestButton.disabled = !csrf;
  }
});

bootstrap();
