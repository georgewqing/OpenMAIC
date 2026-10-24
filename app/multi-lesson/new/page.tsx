import { redirect } from 'next/navigation';

import { isProWorkbenchEnabled, isServerPersistenceConfigured } from '@/lib/config/feature-flags';

import NewMultiLessonClient from './new-client';

export const metadata = { title: '新建多课大纲' };

export default function NewMultiLessonPage() {
  if (!isServerPersistenceConfigured() || !isProWorkbenchEnabled()) redirect('/');
  return <NewMultiLessonClient />;
}
