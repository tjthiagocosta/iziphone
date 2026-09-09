'use client';

import type { UpdateDepartment } from '@repo/dto';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AgentManager } from '@/components/admin/departments/AgentManager';
import { BusinessHoursEditor } from '@/components/admin/departments/BusinessHoursEditor';
import { RoutingSettings } from '@/components/admin/departments/RoutingSettings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  useDepartment,
  useDepartmentMutations,
} from '@/hooks/use-admin-departments';

const VALID_TABS = ['general', 'hours', 'routing', 'agents', 'phones'] as const;
type TabValue = (typeof VALID_TABS)[number];

export default function DepartmentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const departmentId = params.id as string;

  // Get tab from URL or default to 'general'
  const tabParam = searchParams.get('tab');
  const currentTab: TabValue =
    tabParam && VALID_TABS.includes(tabParam as TabValue)
      ? (tabParam as TabValue)
      : 'general';

  const handleTabChange = (value: string) => {
    const newParams = new URLSearchParams(searchParams.toString());
    newParams.set('tab', value);
    router.replace(`?${newParams.toString()}`, { scroll: false });
  };

  const { department, isLoading, refetch } = useDepartment(departmentId);
  const {
    update,
    updateSettings,
    setBusinessHours,
    reorderAgents,
    addAgent,
    removeAgent,
    isLoading: isMutating,
  } = useDepartmentMutations();

  const [formData, setFormData] = useState<UpdateDepartment>({});
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (department) {
      setFormData({
        name: department.name,
        description: department.description || '',
      });
    }
  }, [department]);

  const handleSaveBasicInfo = async () => {
    const updates: UpdateDepartment = {};
    if (formData.name !== department?.name) updates.name = formData.name;
    if (formData.description !== department?.description)
      updates.description = formData.description;

    if (Object.keys(updates).length === 0) return;

    try {
      await update(departmentId, updates);
      setHasChanges(false);
      refetch();
    } catch {
      // Handled by the hook, which keeps the error for the page
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!department) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" asChild>
          <Link href="/admin/departments">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Departments
          </Link>
        </Button>
        <div className="text-center py-12">
          <p className="text-muted-foreground">Department not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/admin/departments">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{department.name}</h1>
          <p className="text-muted-foreground">Manage department settings</p>
        </div>
      </div>

      <Tabs
        value={currentTab}
        onValueChange={handleTabChange}
        className="space-y-6"
      >
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="hours">Business Hours</TabsTrigger>
          <TabsTrigger value="routing">Routing</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="phones">Phone Numbers</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={formData.name || ''}
                  onChange={(e) => {
                    setFormData((prev) => ({ ...prev, name: e.target.value }));
                    setHasChanges(true);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description || ''}
                  onChange={(e) => {
                    setFormData((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }));
                    setHasChanges(true);
                  }}
                  rows={3}
                />
              </div>

              <Button
                onClick={handleSaveBasicInfo}
                disabled={!hasChanges || isMutating}
              >
                {isMutating ? 'Saving...' : 'Save Changes'}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="hours">
          <Card>
            <CardHeader>
              <CardTitle>Business Hours</CardTitle>
            </CardHeader>
            <CardContent>
              <BusinessHoursEditor
                hours={department.businessHours}
                onSave={async (hours) => {
                  await setBusinessHours(departmentId, hours);
                  refetch();
                }}
                isLoading={isMutating}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="routing">
          <Card>
            <CardHeader>
              <CardTitle>Call Routing Settings</CardTitle>
            </CardHeader>
            <CardContent>
              {department.settings ? (
                <RoutingSettings
                  settings={department.settings}
                  agents={department.agents}
                  onSave={async (data) => {
                    await updateSettings(departmentId, data);
                    refetch();
                  }}
                  onReorderAgents={async (data) => {
                    await reorderAgents(departmentId, data);
                    refetch();
                  }}
                  isLoading={isMutating}
                />
              ) : (
                <p className="text-muted-foreground">
                  No settings found for this department
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="agents">
          <Card>
            <CardHeader>
              <CardTitle>Agents</CardTitle>
            </CardHeader>
            <CardContent>
              <AgentManager
                agents={department.agents}
                onAddAgent={async (userId: string) => {
                  await addAgent(departmentId, {
                    userId,
                    order: department.agents.length,
                  });
                  refetch();
                }}
                onRemoveAgent={async (userId: string) => {
                  await removeAgent(departmentId, userId);
                  refetch();
                }}
                isLoading={isMutating}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="phones">
          <Card>
            <CardHeader>
              <CardTitle>Phone Numbers</CardTitle>
            </CardHeader>
            <CardContent>
              {department.phoneNumbers.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No phone numbers assigned to this department
                </p>
              ) : (
                <div className="space-y-2">
                  {department.phoneNumbers.map((phone) => (
                    <div
                      key={phone.id}
                      className="flex items-center justify-between p-3 rounded-md border"
                    >
                      <div>
                        <span className="font-mono">{phone.phoneNumber}</span>
                        {phone.label && (
                          <span className="ml-2 text-muted-foreground text-sm">
                            ({phone.label})
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Badge variant="outline">{phone.type}</Badge>
                        {phone.isPrimary && <Badge>Primary</Badge>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
