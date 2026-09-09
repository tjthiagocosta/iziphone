'use client';

import { use } from 'react';
import { DepartmentView } from '@/components/departments/DepartmentView';

interface DepartmentPageProps {
  params: Promise<{ id: string }>;
}

export default function DepartmentPage({ params }: DepartmentPageProps) {
  const { id } = use(params);
  return <DepartmentView departmentId={id} />;
}
