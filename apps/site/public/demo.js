// smurg.ai: the moving picture of the home page. Progressive enhancement: the stylesheet plays the loop by itself, and
// Pause is the stylesheet's alone, with or without this script (the button opens a popover, and the motion stands
// while it is open): nothing here touches the button or the popover, it only reads whether the popover is open. With
// the script a part of the strip can be pressed to jump to its scene, the strip says which part is on (aria-current),
// and the loop only plays while the window is on the screen. The script moves the clock of the stylesheet's
// animations and sets a class and attributes: it writes no HTML and uses no network.
(() => {
  const story = document.querySelector('.story');
  const clock = story?.querySelector('.scene');
  if (!story || !clock || typeof story.getAnimations !== 'function') return;
  const animations = () => story.getAnimations({ subtree: true });
  // Nothing moves (reduced motion, or a browser the stylesheet keeps still): the still picture needs no script.
  if (animations().length === 0) return;

  const SCENE = 5000; // milliseconds a scene lasts: --scene in style.css
  const LOOP = 4 * SCENE; // --loop
  const FINISHED = 4600; // into a scene, where everything in it has happened and nothing has faded yet
  /** Where the loop is: every animation of the picture runs on the clock of the first scene's. */
  const now = () => Number(clock.getAnimations()[0]?.currentTime) || 0;
  const seek = (ms) => {
    for (const animation of animations()) animation.currentTime = ms;
  };

  /** Whether the visitor paused the picture: the popover its Pause button opens (where anything moves, popovers exist). */
  const state = document.getElementById('story-paused');
  const paused = () => state?.matches(':popover-open') === true;

  // The strip: pressing a part shows its scene from the start, or finished while the picture is paused (and it stays
  // paused). The part whose scene is on carries aria-current.
  const tabs = [...story.querySelectorAll('.tab')];
  let current = -1;
  const mark = () => {
    const index = Math.floor((now() % LOOP) / SCENE);
    if (index === current) return;
    current = index;
    tabs.forEach((tab, i) => {
      if (i === index) tab.setAttribute('aria-current', 'step');
      else tab.removeAttribute('aria-current');
    });
  };
  tabs.forEach((tab, index) => {
    tab.disabled = false;
    tab.addEventListener('click', () => {
      seek(index * SCENE + (paused() ? FINISHED : 0));
      mark();
    });
  });
  mark();
  setInterval(mark, 250);

  // Off the screen the loop waits (a class the stylesheet reads, apart from the visitor's own Pause).
  const win = story.querySelector('.win');
  if (win && 'IntersectionObserver' in window) {
    new IntersectionObserver((entries) => story.classList.toggle('is-away', entries.at(-1)?.isIntersecting === false)).observe(win);
  }

  // A part that was not displayed (the phone's picture leaves some out) starts its animation when it appears: after a
  // resize, put every animation back on the one clock.
  let frame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => seek(now()));
  });
})();
