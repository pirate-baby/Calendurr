const status = document.querySelector('#taskwarrior-status');

fetch('/api/health')
  .then(async response => {
    if (!response.ok) throw new Error((await response.json()).error || 'Unavailable');
    status.textContent = 'Connected';
    status.classList.add('connected');
  })
  .catch(error => {
    status.textContent = error.message || 'Not connected';
    status.classList.add('unavailable');
  });
