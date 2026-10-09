// smurg.ai: the Copy button next to the install command. Progressive enhancement: without this script, or without
// the async clipboard API, the button stays hidden and the command is plain text to select. No innerHTML, no network.
(() => {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return;
  const status = document.getElementById('copy-status');

  for (const button of document.querySelectorAll('button[data-copy]')) {
    const source = document.getElementById(button.getAttribute('data-copy') ?? '');
    if (!source) continue;
    const label = button.textContent;
    let timer = 0;
    // What happened goes on the button ("Copied") and into the status line for screen readers. A hint (the clipboard
    // said no) is too long for the button: it shows in the status line instead, which the stylesheet puts in the
    // place of the note beside the command for that moment, so nothing on the page changes its size.
    const say = (text, hint = false) => {
      if (!hint || !status) button.textContent = text;
      if (status) {
        status.textContent = text;
        status.className = hint ? 'copy-hint' : 'visually-hidden';
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = label;
        if (status) {
          status.textContent = '';
          status.className = 'visually-hidden';
        }
      }, 2500);
    };
    button.hidden = false;
    button.addEventListener('click', () => {
      clipboard.writeText(source.textContent.trim()).then(
        () => say(button.getAttribute('data-done') ?? ''),
        () => {
          // Clipboard refused (permissions, insecure context): select the command so the keyboard shortcut works.
          const range = document.createRange();
          range.selectNodeContents(source);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          say(button.getAttribute('data-fail') ?? '', true);
        },
      );
    });
  }
})();
