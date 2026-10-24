import { redirect } from 'next/navigation';

import { isProWorkbenchEnabled, isServerPersistenceConfigured } from '@/lib/config/feature-flags';

import CourseClient from './course-client';

export const metadata = { title: '多课大纲' };

export const dynamic = 'force-dynamic';

export default async function MultiLessonCoursePage({
  params,
}: {
  params: Promise<{ folderId: string }>;
}) {
  if (!isServerPersistenceConfigured() || !isProWorkbenchEnabled()) redirect('/');
  const { folderId } = await params;
  return <CourseClient folderId={folderId} />;
}
