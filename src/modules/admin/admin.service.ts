import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserMaster } from '../auth/entities';
import { UserActivity } from './entities/user-activity.entity';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
    @InjectRepository(UserActivity)
    private userActivityRepository: Repository<UserActivity>,
  ) {}

  async getDashboardData() {
    // BUG FIX: these counts/joins used to read the modern `users` table (near
    // empty — real accounts live in usermaster, which real login checks
    // first), so "total/active users" and "recent activities" author names
    // were meaningless. usermaster has no `user` relation on UserActivity —
    // resolved manually below.
    const [
      totalUsers,
      activeUsers,
      recentActivities,
    ] = await Promise.all([
      this.userMasterRepository.count(),
      this.userMasterRepository.count({ where: { enableDisable: 'E' } }),
      this.userActivityRepository.find({
        take: 10,
        order: { createdAt: 'DESC' },
      }),
    ]);

    const userIds = [...new Set(recentActivities.map(a => a.userId))];
    const userMasters = userIds.length > 0
      ? await this.userMasterRepository.find({ where: { userid: In(userIds) } })
      : [];
    const byId = new Map(userMasters.map(u => [u.userid, u]));

    return {
      statistics: {
        totalUsers,
        activeUsers,
        inactiveUsers: totalUsers - activeUsers,
      },
      recentActivities: recentActivities.map(activity => {
        const userMaster = byId.get(activity.userId);
        return {
          id: activity.id,
          activityType: activity.activityType,
          description: activity.description,
          createdAt: activity.createdAt,
          user: userMaster ? {
            id: userMaster.userid,
            username: userMaster.susername,
            firstName: userMaster.firstName || userMaster.susername,
            lastName: userMaster.lastName || '',
          } : null,
        };
      }),
    };
  }

  async getSystemInfo() {
    const nodeVersion = process.version;
    const platform = process.platform;
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();

    return {
      nodeVersion,
      platform,
      uptime: Math.floor(uptime),
      memoryUsage: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
