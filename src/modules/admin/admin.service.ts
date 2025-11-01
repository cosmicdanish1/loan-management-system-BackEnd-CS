import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { UserActivity } from './entities/user-activity.entity';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserActivity)
    private userActivityRepository: Repository<UserActivity>,
  ) {}

  async getDashboardData() {
    const [
      totalUsers,
      activeUsers,
      recentActivities,
    ] = await Promise.all([
      this.userRepository.count(),
      this.userRepository.count({ where: { isActive: true } }),
      this.userActivityRepository.find({
        relations: ['user'],
        take: 10,
        order: { createdAt: 'DESC' },
      }),
    ]);

    return {
      statistics: {
        totalUsers,
        activeUsers,
        inactiveUsers: totalUsers - activeUsers,
      },
      recentActivities: recentActivities.map(activity => ({
        id: activity.id,
        activityType: activity.activityType,
        description: activity.description,
        createdAt: activity.createdAt,
        user: activity.user ? {
          id: activity.user.id,
          username: activity.user.username,
          firstName: activity.user.firstName,
          lastName: activity.user.lastName,
        } : null,
      })),
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
