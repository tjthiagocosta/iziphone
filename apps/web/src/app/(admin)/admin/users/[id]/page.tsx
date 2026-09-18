'use client';

import type { Role, UpdateUser } from '@repo/dto';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useUser, useUserMutations } from '@/hooks/use-admin-users';
import {
  inviteStatusLabel,
  inviteStatusTone,
  needsInvite,
} from '@/lib/access-link';

export default function UserDetailPage() {
  const params = useParams();
  const userId = params.id as string;

  const { user, isLoading, refetch } = useUser(userId);
  const { update, isLoading: isMutating } = useUserMutations();

  const [formData, setFormData] = useState<UpdateUser>({});
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (user) {
      setFormData({
        name: user.name || '',
        email: user.email,
        role: user.role,
      });
    }
  }, [user]);

  const handleSave = async () => {
    const updates: UpdateUser = {};

    if (formData.name !== user?.name) updates.name = formData.name;
    if (formData.email !== user?.email) updates.email = formData.email;
    if (formData.role !== user?.role) updates.role = formData.role;

    if (Object.keys(updates).length === 0) return;

    try {
      await update(userId, updates);
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

  if (!user) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" asChild>
          <Link href="/admin/users">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Users
          </Link>
        </Button>
        <div className="text-center py-12">
          <p className="text-muted-foreground">User not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/admin/users">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{user.name || user.email}</h1>
          <p className="text-muted-foreground">Edit user details</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Basic Info */}
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
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={formData.email || ''}
                onChange={(e) => {
                  setFormData((prev) => ({ ...prev, email: e.target.value }));
                  setHasChanges(true);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <Select
                value={formData.role}
                onValueChange={(value: Role) => {
                  setFormData((prev) => ({ ...prev, role: value }));
                  setHasChanges(true);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AGENT">Agent</SelectItem>
                  <SelectItem value="SUPERVISOR">Supervisor</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Separator />

            {/*
              No password field: nobody sets somebody else's password here.
              A user who cannot get in is sent a link from the Users list.
            */}
            <div className="space-y-2">
              <Label>Access</Label>
              <div>
                <Badge variant={inviteStatusTone(user.inviteStatus)}>
                  {inviteStatusLabel(user.inviteStatus)}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {needsInvite(user.inviteStatus)
                  ? 'They have not chosen a password yet. Resend their invite from the Users list.'
                  : 'They have a password. Send a reset link from the Users list if they are locked out.'}
              </p>
            </div>

            <Button
              onClick={handleSave}
              disabled={!hasChanges || isMutating}
              className="w-full"
            >
              {isMutating ? 'Saving...' : 'Save Changes'}
            </Button>
          </CardContent>
        </Card>

        {/* Departments */}
        <Card>
          <CardHeader>
            <CardTitle>Departments</CardTitle>
          </CardHeader>
          <CardContent>
            {user.departments.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Not assigned to any departments
              </p>
            ) : (
              <div className="space-y-2">
                {user.departments.map((dept) => (
                  <div
                    key={dept.id}
                    className="flex items-center justify-between p-2 rounded-md border"
                  >
                    <span>{dept.departmentName}</span>
                    <Badge variant="outline">Order: {dept.order}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Phone Numbers */}
        <Card>
          <CardHeader>
            <CardTitle>Phone Numbers</CardTitle>
          </CardHeader>
          <CardContent>
            {user.phoneNumbers.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No phone numbers assigned
              </p>
            ) : (
              <div className="space-y-2">
                {user.phoneNumbers.map((phone) => (
                  <div
                    key={phone.id}
                    className="flex items-center justify-between p-2 rounded-md border"
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

        {/* Account Info */}
        <Card>
          <CardHeader>
            <CardTitle>Account Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">User ID</span>
              <span className="font-mono">{user.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email Verified</span>
              <Badge variant={user.emailVerified ? 'default' : 'secondary'}>
                {user.emailVerified ? 'Yes' : 'No'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{new Date(user.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Updated</span>
              <span>{new Date(user.updatedAt).toLocaleDateString()}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
