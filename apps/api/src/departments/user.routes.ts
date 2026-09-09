import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from '../auth/index.js';

/*
 * The web app colors each department consistently; the palette lives here so
 * every client agrees. Moving it to the web is a cross-app change.
 */
const DEPARTMENT_COLORS = [
  'bg-purple-600',
  'bg-blue-600',
  'bg-green-600',
  'bg-orange-600',
  'bg-pink-600',
  'bg-teal-600',
  'bg-indigo-600',
  'bg-red-600',
  'bg-cyan-600',
  'bg-yellow-600',
] as const;

function getDepartmentColor(departmentId: string): string {
  const hash = departmentId
    .split('')
    .reduce((acc, char) => char.charCodeAt(0) + ((acc << 5) - acc), 0);
  return (
    DEPARTMENT_COLORS[Math.abs(hash) % DEPARTMENT_COLORS.length] ??
    DEPARTMENT_COLORS[0]
  );
}

/** The departments the authenticated user belongs to, with their numbers. */
export const userDepartmentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request) => {
    const userId = authenticatedUser(request).id;

    const userDepartments = await fastify.db.userDepartment.findMany({
      where: {
        userId,
        department: { deletedAt: null },
      },
      orderBy: { order: 'asc' },
      include: {
        department: {
          include: {
            phoneNumbers: {
              where: { status: 'ACTIVE', deletedAt: null },
              select: {
                phoneNumber: true,
                isPrimary: true,
              },
              orderBy: { isPrimary: 'desc' },
            },
          },
        },
      },
    });

    const departments = userDepartments.map((ud) => ({
      id: ud.department.id,
      name: ud.department.name,
      color: getDepartmentColor(ud.department.id),
      phoneNumbers: ud.department.phoneNumbers.map((pn) => ({
        number: pn.phoneNumber,
        isDefault: pn.isPrimary,
      })),
    }));

    return { departments };
  });
};
