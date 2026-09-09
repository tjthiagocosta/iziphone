// Mock data for UI development - will be replaced with real API calls

export interface MockContact {
  id: string;
  name: string | null;
  phoneNumber: string;
  avatarColor: string;
  initials: string;
  status?: 'available' | 'dnd' | 'offline';
  departmentBadge?: string;
}

export interface MockDepartment {
  id: string;
  name: string;
  color: string;
  phoneNumbers: { number: string; isDefault: boolean }[];
}

export interface MockInteraction {
  id: string;
  type: 'call' | 'message' | 'voicemail';
  direction: 'inbound' | 'outbound';
  status: 'completed' | 'missed' | 'busy' | 'no-answer';
  contact: MockContact;
  from: string;
  to: string;
  timestamp: Date;
  duration?: number; // seconds
  content?: string; // for messages
  summary?: string; // AI summary for calls
  category?: string; // e.g., "Other", "Sales", "Support"
  isRead: boolean;
  isStarred: boolean;
}

// Avatar colors for contacts
export const AVATAR_COLORS = [
  'bg-green-500',
  'bg-blue-500',
  'bg-purple-500',
  'bg-pink-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-teal-500',
  'bg-indigo-500',
  'bg-red-500',
  'bg-cyan-500',
] as const;

// Generate initials from name or phone number
export function getInitials(name: string | null, phoneNumber: string): string {
  if (name) {
    const parts = name.split(' ').filter(Boolean);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length >= 2 ? (parts[parts.length - 1]?.[0] ?? '') : '';
    if (first && last) {
      return `${first}${last}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  // Use last 2 digits of phone number
  return phoneNumber.slice(-2);
}

// Get a consistent color based on string
export function getAvatarColor(identifier: string): string {
  const hash = identifier.split('').reduce((acc, char) => {
    return char.charCodeAt(0) + ((acc << 5) - acc);
  }, 0);
  return (
    AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]
  );
}

// Format phone number for display
export { formatPhoneNumber } from '@/lib/phone-number';

// Mock departments
// Note: phone numbers use the NANP-reserved fictional range (555-0100 to 555-0199)
export const mockDepartments: MockDepartment[] = [
  {
    id: 'dept-1',
    name: 'Northwind Traders',
    color: 'bg-purple-600',
    phoneNumbers: [
      { number: '+15155550101', isDefault: true },
      { number: '+15155550102', isDefault: false },
    ],
  },
  {
    id: 'dept-2',
    name: 'Sales',
    color: 'bg-blue-600',
    phoneNumbers: [{ number: '+15155550103', isDefault: true }],
  },
];

// Mock contacts
export const mockContacts: MockContact[] = [
  {
    id: 'contact-1',
    name: 'Riverside Supply Co',
    phoneNumber: '+15155550104',
    avatarColor: 'bg-blue-500',
    initials: 'RS',
    status: 'available',
  },
  {
    id: 'contact-2',
    name: 'Jordan Blake',
    phoneNumber: '+15155550105',
    avatarColor: 'bg-green-500',
    initials: 'JB',
    status: 'available',
    departmentBadge: 'NORTHWIND TRADERS',
  },
  {
    id: 'contact-3',
    name: 'Casey Rivera',
    phoneNumber: '+15155550106',
    avatarColor: 'bg-blue-600',
    initials: 'CR',
    status: 'dnd',
  },
  {
    id: 'contact-4',
    name: 'Taylor Brooks',
    phoneNumber: '+15155550107',
    avatarColor: 'bg-green-600',
    initials: 'TB',
    status: 'dnd',
  },
  {
    id: 'contact-5',
    name: 'Morgan Alvarez',
    phoneNumber: '+15155550108',
    avatarColor: 'bg-pink-500',
    initials: 'MA',
    status: 'available',
  },
  {
    id: 'contact-6',
    name: 'Skylar Novak',
    phoneNumber: '+15155550109',
    avatarColor: 'bg-indigo-500',
    initials: 'SN',
    status: 'available',
  },
  {
    id: 'contact-7',
    name: 'DANA PATEL',
    phoneNumber: '+15155550110',
    avatarColor: 'bg-yellow-500',
    initials: 'DP',
    status: 'dnd',
  },
  {
    id: 'contact-8',
    name: 'Avery Chen',
    phoneNumber: '+15155550111',
    avatarColor: 'bg-purple-500',
    initials: 'AC',
    status: 'available',
  },
  {
    id: 'contact-9',
    name: 'Reese Sullivan',
    phoneNumber: '+15155550112',
    avatarColor: 'bg-teal-500',
    initials: 'RS',
    status: 'available',
  },
  {
    id: 'contact-10',
    name: null,
    phoneNumber: '+15155550113',
    avatarColor: 'bg-gray-500',
    initials: '13',
    status: 'offline',
  },
  {
    id: 'contact-11',
    name: 'Harbor View Realty',
    phoneNumber: '+15155550114',
    avatarColor: 'bg-orange-500',
    initials: 'HV',
    status: 'available',
  },
  {
    id: 'contact-12',
    name: null,
    phoneNumber: '+15155550115',
    avatarColor: 'bg-gray-500',
    initials: '15',
    status: 'offline',
  },
  {
    id: 'contact-13',
    name: 'Devon Marsh',
    phoneNumber: '+15155550116',
    avatarColor: 'bg-cyan-500',
    initials: 'DM',
    status: 'available',
  },
  {
    id: 'contact-14',
    name: null,
    phoneNumber: '+15155550117',
    avatarColor: 'bg-gray-500',
    initials: '17',
    status: 'offline',
  },
  {
    id: 'contact-15',
    name: 'Alex Morgan',
    phoneNumber: '+15155550118',
    avatarColor: 'bg-green-500',
    initials: 'AM',
    status: 'available',
    departmentBadge: 'NORTHWIND TRADERS',
  },
];

function mockContact(index: number): MockContact {
  const contact = mockContacts[index];
  if (!contact) {
    throw new Error(`No mock contact at index ${index}`);
  }
  return contact;
}

// Mock recent interactions (15 items)
export const mockRecentInteractions: MockInteraction[] = [
  {
    id: 'int-1',
    type: 'call',
    direction: 'outbound',
    status: 'completed',
    contact: mockContact(0),
    from: '+15155550118',
    to: '+15155550104',
    timestamp: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
    duration: 60,
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-2',
    type: 'call',
    direction: 'inbound',
    status: 'missed',
    contact: mockContact(0),
    from: '+15155550104',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
    isRead: false,
    isStarred: false,
  },
  {
    id: 'int-3',
    type: 'call',
    direction: 'inbound',
    status: 'completed',
    contact: mockContact(1),
    from: '+15155550105',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), // Yesterday
    duration: 120,
    summary:
      'The conversation involves the agent and Jordan discussing various topics. They mention a voicemail and an upcoming meeting. Jordan seems to be confirming details about a day or event.',
    category: 'Other',
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-4',
    type: 'message',
    direction: 'inbound',
    status: 'completed',
    contact: mockContact(2),
    from: '+15155550106',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), // Yesterday
    content: 'Hey, can you call me back?',
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-5',
    type: 'call',
    direction: 'inbound',
    status: 'missed',
    contact: mockContact(3),
    from: '+15155550107',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), // Yesterday
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-6',
    type: 'call',
    direction: 'outbound',
    status: 'completed',
    contact: mockContact(4),
    from: '+15155550118',
    to: '+15155550108',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), // Yesterday
    duration: 45,
    isRead: true,
    isStarred: true,
  },
  {
    id: 'int-7',
    type: 'message',
    direction: 'outbound',
    status: 'completed',
    contact: mockContact(5),
    from: '+15155550118',
    to: '+15155550109',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), // Yesterday
    content: 'Thank you so much.',
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-8',
    type: 'call',
    direction: 'inbound',
    status: 'missed',
    contact: mockContact(8),
    from: '+15155550112',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 48), // 2 days ago
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-9',
    type: 'call',
    direction: 'inbound',
    status: 'missed',
    contact: mockContact(9),
    from: '+15155550113',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 72), // 3 days ago
    isRead: false,
    isStarred: false,
  },
  {
    id: 'int-10',
    type: 'call',
    direction: 'inbound',
    status: 'missed',
    contact: mockContact(10),
    from: '+15155550114',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 96), // 4 days ago
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-11',
    type: 'message',
    direction: 'inbound',
    status: 'completed',
    contact: mockContact(11),
    from: '+15155550115',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 120), // 5 days ago
    content: '463191 is your verification code.',
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-12',
    type: 'message',
    direction: 'outbound',
    status: 'completed',
    contact: mockContact(12),
    from: '+15155550118',
    to: '+15155550116',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 144), // 6 days ago
    content:
      'Good morning Devon, I hope this message finds you well, and I wish you an incredible day ahead.',
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-13',
    type: 'call',
    direction: 'outbound',
    status: 'completed',
    contact: mockContact(13),
    from: '+15155550118',
    to: '+15155550117',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 168), // 7 days ago
    duration: 180,
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-14',
    type: 'message',
    direction: 'inbound',
    status: 'completed',
    contact: mockContact(9),
    from: '+15155550113',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 192), // 8 days ago
    content: 'G-578620 is your verification code.',
    isRead: true,
    isStarred: false,
  },
  {
    id: 'int-15',
    type: 'voicemail',
    direction: 'inbound',
    status: 'completed',
    contact: mockContact(6),
    from: '+15155550110',
    to: '+15155550118',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 216), // 9 days ago
    duration: 30,
    isRead: false,
    isStarred: false,
  },
];

// Current user mock data
export const mockCurrentUser = {
  id: 'user-1',
  name: 'Alex Morgan',
  email: 'alex.morgan@example.com',
  phoneNumber: '+15155550118',
  avatarColor: 'bg-green-500',
  initials: 'AM',
  role: 'AGENT' as const,
  departments: [mockDepartments[0]],
};

// Format relative time
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    // Today - show time
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  } else {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }
}

// Format duration in seconds to mm:ss
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
