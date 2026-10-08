// What the page does once, when it starts (createBrowserServices, called by main.tsx before the first render).
import { describe, expect, it } from 'vitest';
import { createBrowserServices } from './services.tsx';
import { readLayout } from './workspace/layout.ts';

describe('the page starts in a browser that ran smurg 0.4.0', () => {
  it('the panel settings are carried before anything reads them, and the keys nothing reads are gone', () => {
    // As 0.4.0 wrote them (its own code; layout.test.ts has the whole profile).
    window.localStorage.setItem('smurg.layout', '{"sidebar":false,"right":false,"drawer":true,"drawerTab":"merge-requests","suggestions":false,"agentsWide":true}');
    window.localStorage.setItem('smurg.pane.suggestions', '310');
    window.localStorage.setItem('smurg.pane.right', '555');
    window.localStorage.setItem('smurg.agents.closedSessions', '{"CvBmHPJWyOWAdsmuttOLQQ":["s_0123456789abcdef"]}');
    window.localStorage.setItem('smurg.recentWorkspaces', '[{"id":"CvBmHPJWyOWAdsmuttOLQQ","name":"test","hostName":"GCman","lastOpenedAt":1759800000000}]');

    const services = createBrowserServices();
    try {
      expect(readLayout()).toEqual({ left: true, inbox: true, sessions: true, files: false, side: false, drawer: true, drawerTab: 'activity' });
      expect(window.localStorage.getItem('smurg.layout')).toBe('{"left":true,"inbox":true,"sessions":true,"files":false,"side":false,"drawer":true,"drawerTab":"activity"}');
      expect(window.localStorage.getItem('smurg.pane.side')).toBe('555');
      expect(window.localStorage.getItem('smurg.pane.right')).toBeNull();
      expect(window.localStorage.getItem('smurg.pane.suggestions')).toBeNull();
      expect(window.localStorage.getItem('smurg.agents.closedSessions')).toBeNull();
      // The way back into the workspace is untouched.
      expect(services.recent.getState()).toEqual([{ id: 'CvBmHPJWyOWAdsmuttOLQQ', name: 'test', hostName: 'GCman', lastOpenedAt: 1_759_800_000_000 }]);
    } finally {
      services.theme.dispose();
    }
  });
});
