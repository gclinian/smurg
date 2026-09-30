// React bindings of the router: the current route, in-app links and navigation.
import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { parseRoute, type Route } from '../lib/router.ts';
import { shallowEqual, useStore } from '../lib/store.ts';
import { useAppServices } from './services.tsx';

export function useRoute(): Route {
  const { router } = useAppServices();
  return useStore(router, (location) => parseRoute(location.pathname), shallowEqual);
}

export function useNavigate(): (path: string, options?: { replace?: boolean }) => void {
  const { router } = useAppServices();
  return router.navigate;
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** An in-app path (`/w/<id>`). */
  to: string;
  replace?: boolean;
}

/** An <a> for in-app navigation: a plain click navigates without a reload; modified clicks behave like links. */
export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  const { router } = useAppServices();
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.navigate(to, replace ? { replace } : undefined);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
