// Renders a component the way a column's frame would (lib/columns/context.tsx), for the tests of a column kind's
// body: the test decides whether the column is focused and on screen, asks it to scroll to an anchor, and reads what
// the body put into the header.
//
//   const view = renderInColumn(<ConversationColumn sessionId="s1" />, { target: { kind: 'session', sessionId: 's1' } });
//   view.column.set({ visible: false });                 // the other mode is shown: the body should stop watching live
//   view.column.anchor({ cardId: 'q_1' });               // an inbox item was opened: the body scrolls and focuses the card
//   expect(view.column.anchorsShown()).toBe(1);          // … and said so
//   expect(view.column.menuItems().map((item) => item.id)).toContain('rename');
//   within(view.column.header).getByText('Attempt 2 of 2');
import { act, render, type RenderResult } from '@testing-library/react';
import { useCallback, useImperativeHandle, useMemo, useState, type ReactElement, type Ref } from 'react';
import { ColumnContextProvider, type ColumnAnchorRequest, type ColumnContextValue } from '../lib/columns/context.tsx';
import { columnId, type ColumnAnchor, type ColumnRef } from '../lib/columns/target.ts';
import type { MenuItem } from '../ui/Menu.tsx';
import { WorkspaceTestProviders, createTestWorkspace, type WorkspaceTestContext } from './services.tsx';

interface ColumnFlags {
  readonly focused: boolean;
  readonly visible: boolean;
  readonly place: 'strip' | 'code';
}

interface Controller {
  set(flags: Partial<ColumnFlags>): void;
  anchor(anchor: ColumnAnchor): void;
  anchorsShown(): number;
  menuItems(): MenuItem[];
}

export interface ColumnTestHandle extends Controller {
  /** The header's part where ColumnHeaderExtra renders. */
  readonly header: HTMLElement;
}

function Harness({ target, initial, children, controller }: { target: ColumnRef; initial: ColumnFlags; children: ReactElement; controller: Ref<Controller> }) {
  const [flags, setFlags] = useState(initial);
  const [anchor, setAnchor] = useState<ColumnAnchorRequest | null>(null);
  const [shown, setShown] = useState(0);
  const [menus, setMenus] = useState<ReadonlyMap<object, readonly MenuItem[]>>(new Map());
  const [headerExtraNode, setHeaderExtraNode] = useState<HTMLElement | null>(null);

  const setMenuItems = useCallback((owner: object, items: readonly MenuItem[] | null) => {
    setMenus((previous) => {
      const next = new Map(previous);
      if (items === null) next.delete(owner);
      else next.set(owner, items);
      return next;
    });
  }, []);
  const anchorShown = useCallback(() => {
    setShown((count) => count + 1);
    setAnchor(null);
  }, []);

  useImperativeHandle(
    controller,
    () => ({
      set: (next) => setFlags((previous) => ({ ...previous, ...next })),
      anchor: (next) => setAnchor((previous) => ({ ...next, token: (previous?.token ?? 0) + 1 })),
      anchorsShown: () => shown,
      menuItems: () => [...menus.values()].flat(),
    }),
    [shown, menus],
  );

  const value = useMemo<ColumnContextValue>(
    () => ({ id: columnId(target), target, ...flags, anchor, anchorShown, headerExtraNode, setMenuItems }),
    [target, flags, anchor, anchorShown, headerExtraNode, setMenuItems],
  );
  return (
    <section className="col" aria-label="test column" data-column-id={columnId(target)}>
      <header className="col-head">
        <div className="col-head__extra" data-testid="column-header-extra" ref={setHeaderExtraNode} />
      </header>
      <ColumnContextProvider value={value}>
        <div className="col-body">{children}</div>
      </ColumnContextProvider>
    </section>
  );
}

export interface RenderInColumnOptions extends NonNullable<Parameters<typeof createTestWorkspace>[0]> {
  target: ColumnRef;
  focused?: boolean;
  visible?: boolean;
  place?: 'strip' | 'code';
}

/** Renders `ui` as the body of a column inside a test workspace (see createTestWorkspace for the other options). */
export function renderInColumn(ui: ReactElement, options: RenderInColumnOptions): RenderResult & WorkspaceTestContext & { column: ColumnTestHandle } {
  const { target, focused = true, visible = true, place = 'strip', ...workspace } = options;
  const context = createTestWorkspace(workspace);
  const controller: { current: Controller | null } = { current: null };
  const result = render(
    <WorkspaceTestProviders context={context}>
      <Harness target={target} initial={{ focused, visible, place }} controller={controller}>
        {ui}
      </Harness>
    </WorkspaceTestProviders>,
  );
  const live = (): Controller => {
    if (controller.current === null) throw new Error('the column harness is not mounted');
    return controller.current;
  };
  const column: ColumnTestHandle = {
    set: (flags) => act(() => live().set(flags)),
    anchor: (anchor) => act(() => live().anchor(anchor)),
    anchorsShown: () => live().anchorsShown(),
    menuItems: () => live().menuItems(),
    get header() {
      return result.getByTestId('column-header-extra');
    },
  };
  return { ...result, ...context, column };
}
