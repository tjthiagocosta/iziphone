import type { FastifyPluginAsync } from 'fastify';

/**
 * Admin dashboard stats routes
 */
export const adminStatsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/admin/stats
   * Get dashboard statistics
   */
  fastify.get('/', async (_request, reply) => {
    const db = fastify.db;

    // Get user stats
    const [totalUsers, deletedUsers, adminCount, supervisorCount, agentCount] =
      await Promise.all([
        db.user.count({ where: { deletedAt: null } }),
        db.user.count({ where: { NOT: { deletedAt: null } } }),
        db.user.count({ where: { role: 'ADMIN', deletedAt: null } }),
        db.user.count({ where: { role: 'SUPERVISOR', deletedAt: null } }),
        db.user.count({ where: { role: 'AGENT', deletedAt: null } }),
      ]);

    // Get department stats
    const [totalDepartments, deletedDepartments] = await Promise.all([
      db.department.count({ where: { deletedAt: null } }),
      db.department.count({ where: { NOT: { deletedAt: null } } }),
    ]);

    // Get phone number stats
    const [
      totalPhoneNumbers,
      activePhoneNumbers,
      reservedPhoneNumbers,
      releasedPhoneNumbers,
      localNumbers,
      tollFreeNumbers,
    ] = await Promise.all([
      db.phoneNumber.count({ where: { deletedAt: null } }),
      db.phoneNumber.count({ where: { status: 'ACTIVE', deletedAt: null } }),
      db.phoneNumber.count({ where: { status: 'RESERVED', deletedAt: null } }),
      db.phoneNumber.count({ where: { status: 'RELEASED', deletedAt: null } }),
      db.phoneNumber.count({ where: { type: 'LOCAL', deletedAt: null } }),
      db.phoneNumber.count({ where: { type: 'TOLL_FREE', deletedAt: null } }),
    ]);

    return reply.send({
      users: {
        total: totalUsers,
        active: totalUsers,
        deleted: deletedUsers,
        byRole: {
          admin: adminCount,
          supervisor: supervisorCount,
          agent: agentCount,
        },
      },
      departments: {
        total: totalDepartments,
        active: totalDepartments,
        deleted: deletedDepartments,
      },
      phoneNumbers: {
        total: totalPhoneNumbers,
        active: activePhoneNumbers,
        reserved: reservedPhoneNumbers,
        released: releasedPhoneNumbers,
        byType: {
          local: localNumbers,
          tollFree: tollFreeNumbers,
        },
      },
    });
  });
};
