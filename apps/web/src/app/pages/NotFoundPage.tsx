import { useId } from 'react';
import { tApp } from '../../strings/app.ts';
import { Button } from '../../ui/index.ts';
import { FullPage } from '../connection/screens.tsx';
import { useAppServices } from '../services.tsx';

export function NotFoundPage() {
  const { router } = useAppServices();
  const titleId = useId();
  return (
    <FullPage role="main" labelledBy={titleId} testId="not-found">
      <h1 id={titleId}>{tApp('notFound.title')}</h1>
      <p className="app-fullpage__body">{tApp('notFound.body')}</p>
      <div className="app-fullpage__actions">
        <Button variant="primary" onClick={() => router.navigate('/')}>
          {tApp('notFound.home')}
        </Button>
      </div>
    </FullPage>
  );
}
