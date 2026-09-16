import { api, showError } from '/app.js';

const form = document.getElementById('login');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: {
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      },
    });
    window.location.href = '/today';
  } catch (err) {
    showError(err.message);
    button.disabled = false;
  }
});
