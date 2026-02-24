import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';
import { DataConsistencyService } from './data-consistency.service';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { LessThan } from 'typeorm';

export interface SystemHealthMetrics {
  database: DatabaseHealthMetrics;
  application: ApplicationHealthMetrics;
  system: SystemResourceMetrics;
  business: BusinessHealthMetrics;
  overall: OverallHealthStatus;
  timestamp: Date;
}

export interface DatabaseHealthMetrics {
  connectionStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  connectionCount: number;
  queryPerformance: {
    averageResponseTime: number;
    slowQueries: number;
  };
  dataIntegrity: {
    status: 'HEALTHY' | 'ISSUES_FOUND' | 'CRITICAL_ISSUES';
    lastChecked: Date;
    issuesCount: number;
  };
  storage: {
    totalSize: number;
    usedSize: number;
    freeSpace: number;
    growthRate: number;
  };
}

export interface ApplicationHealthMetrics {
  uptime: number;
  memoryUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  cpuUsage: number;
  activeUsers: number;
  errorRate: number;
  responseTime: number;
  cacheHitRate: number;
}

export interface SystemResourceMetrics {
  cpu: {
    usage: number;
    loadAverage: number[];
    cores: number;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    percentage: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    percentage: number;
  };
  network: {
    bytesReceived: number;
    bytesSent: number;
    connectionsActive: number;
  };
}

export interface BusinessHealthMetrics {
  totalMembers: number;
  activeLoans: number;
  totalLoanAmount: number;
  activeDeposits: number;
  totalDepositAmount: number;
  dailyTransactions: number;
  defaulterCount: number;
  systemUtilization: number;
}

export interface OverallHealthStatus {
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'DOWN';
  score: number; // 0-100
  criticalIssues: string[];
  warnings: string[];
  recommendations: string[];
}

export interface HealthAlert {
  id: string;
  type: 'CRITICAL' | 'WARNING' | 'INFO';
  component: string;
  message: string;
  timestamp: Date;
  resolved: boolean;
  resolvedAt?: Date;
}

export interface PerformanceMetrics {
  endpoint: string;
  method: string;
  averageResponseTime: number;
  requestCount: number;
  errorCount: number;
  lastAccessed: Date;
}

@Injectable()
export class SystemHealthMonitoringService {
  private readonly logger = new Logger(SystemHealthMonitoringService.name);
  private healthHistory: SystemHealthMetrics[] = [];
  private activeAlerts: HealthAlert[] = [];
  private performanceMetrics: Map<string, PerformanceMetrics> = new Map();
  private startTime: Date = new Date();

  constructor(
    @InjectRepository(Member)
    private memberRepository: Repository<Member>,
    @InjectRepository(LoanAccount)
    private loanAccountRepository: Repository<LoanAccount>,
    @InjectRepository(FixedDeposit)
    private fixedDepositRepository: Repository<FixedDeposit>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    private dataConsistencyService: DataConsistencyService,
    private dataSource: DataSource,
  ) {
    // Start periodic health monitoring
    this.startPeriodicMonitoring();
  }

  /**
   * Get current system health status
   */
  async getCurrentHealthStatus(): Promise<SystemHealthMetrics> {
    this.logger.log('Collecting system health metrics');

    const [
      databaseHealth,
      applicationHealth,
      systemHealth,
      businessHealth,
    ] = await Promise.all([
      this.getDatabaseHealthMetrics(),
      this.getApplicationHealthMetrics(),
      this.getSystemResourceMetrics(),
      this.getBusinessHealthMetrics(),
    ]);

    const overallHealth = this.calculateOverallHealth(
      databaseHealth,
      applicationHealth,
      systemHealth,
      businessHealth,
    );

    const healthMetrics: SystemHealthMetrics = {
      database: databaseHealth,
      application: applicationHealth,
      system: systemHealth,
      business: businessHealth,
      overall: overallHealth,
      timestamp: new Date(),
    };

    // Store in history (keep last 100 entries)
    this.healthHistory.push(healthMetrics);
    if (this.healthHistory.length > 100) {
      this.healthHistory.shift();
    }

    // Check for alerts
    await this.checkForAlerts(healthMetrics);

    return healthMetrics;
  }

  /**
   * Get health history for trend analysis
   */
  getHealthHistory(hours: number = 24): SystemHealthMetrics[] {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.healthHistory.filter(h => h.timestamp >= cutoffTime);
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): HealthAlert[] {
    return this.activeAlerts.filter(alert => !alert.resolved);
  }

  /**
   * Get all alerts (including resolved)
   */
  getAllAlerts(hours: number = 24): HealthAlert[] {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.activeAlerts.filter(alert => alert.timestamp >= cutoffTime);
  }

  /**
   * Resolve an alert
   */
  resolveAlert(alertId: string): boolean {
    const alert = this.activeAlerts.find(a => a.id === alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      return true;
    }
    return false;
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics[] {
    return Array.from(this.performanceMetrics.values());
  }

  /**
   * Record API performance
   */
  recordApiPerformance(
    endpoint: string,
    method: string,
    responseTime: number,
    isError: boolean = false,
  ): void {
    const key = `${method}:${endpoint}`;
    const existing = this.performanceMetrics.get(key);

    if (existing) {
      // Update existing metrics
      const totalRequests = existing.requestCount + 1;
      existing.averageResponseTime =
        (existing.averageResponseTime * existing.requestCount + responseTime) / totalRequests;
      existing.requestCount = totalRequests;
      existing.errorCount += isError ? 1 : 0;
      existing.lastAccessed = new Date();
    } else {
      // Create new metrics
      this.performanceMetrics.set(key, {
        endpoint,
        method,
        averageResponseTime: responseTime,
        requestCount: 1,
        errorCount: isError ? 1 : 0,
        lastAccessed: new Date(),
      });
    }
  }

  /**
   * Run system diagnostics
   */
  async runSystemDiagnostics(): Promise<{
    healthStatus: SystemHealthMetrics;
    consistencyReport: any;
    recommendations: string[];
  }> {
    this.logger.log('Running comprehensive system diagnostics');

    const [healthStatus, consistencyReport] = await Promise.all([
      this.getCurrentHealthStatus(),
      this.dataConsistencyService.runConsistencyChecks(),
    ]);

    const recommendations = this.generateSystemRecommendations(healthStatus, consistencyReport);

    return {
      healthStatus,
      consistencyReport,
      recommendations,
    };
  }

  private async getDatabaseHealthMetrics(): Promise<DatabaseHealthMetrics> {
    try {
      const startTime = Date.now();

      // Test database connection
      await this.dataSource.query('SELECT 1');
      const responseTime = Date.now() - startTime;

      // Get connection pool info
      const connectionCount = this.dataSource.isInitialized ? 1 : 0;

      // Run quick data integrity check
      const integrityCheck = await this.dataConsistencyService.runConsistencyChecks();

      let integrityStatus: 'HEALTHY' | 'ISSUES_FOUND' | 'CRITICAL_ISSUES' = 'HEALTHY';
      if (integrityCheck.overallStatus === 'CRITICAL_ISSUES') {
        integrityStatus = 'CRITICAL_ISSUES';
      } else if (integrityCheck.overallStatus === 'ISSUES_FOUND') {
        integrityStatus = 'ISSUES_FOUND';
      }

      // Get database size (simplified)
      const tableCount = await this.dataSource.query(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public'"
      );

      return {
        connectionStatus: responseTime < 1000 ? 'HEALTHY' : responseTime < 5000 ? 'WARNING' : 'CRITICAL',
        connectionCount,
        queryPerformance: {
          averageResponseTime: responseTime,
          slowQueries: responseTime > 1000 ? 1 : 0,
        },
        dataIntegrity: {
          status: integrityStatus,
          lastChecked: new Date(),
          issuesCount: integrityCheck.failedChecks + integrityCheck.warningChecks,
        },
        storage: {
          totalSize: 0, // Would need specific database queries
          usedSize: 0,
          freeSpace: 0,
          growthRate: 0,
        },
      };
    } catch (error) {
      this.logger.error('Database health check failed', error.stack);
      return {
        connectionStatus: 'CRITICAL',
        connectionCount: 0,
        queryPerformance: {
          averageResponseTime: 0,
          slowQueries: 0,
        },
        dataIntegrity: {
          status: 'CRITICAL_ISSUES',
          lastChecked: new Date(),
          issuesCount: 1,
        },
        storage: {
          totalSize: 0,
          usedSize: 0,
          freeSpace: 0,
          growthRate: 0,
        },
      };
    }
  }

  private async getApplicationHealthMetrics(): Promise<ApplicationHealthMetrics> {
    const memUsage = process.memoryUsage();
    const uptime = Date.now() - this.startTime.getTime();

    // Calculate error rate from performance metrics
    const allMetrics = Array.from(this.performanceMetrics.values());
    const totalRequests = allMetrics.reduce((sum, m) => sum + m.requestCount, 0);
    const totalErrors = allMetrics.reduce((sum, m) => sum + m.errorCount, 0);
    const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;

    // Calculate average response time
    const avgResponseTime = allMetrics.length > 0
      ? allMetrics.reduce((sum, m) => sum + m.averageResponseTime, 0) / allMetrics.length
      : 0;

    return {
      uptime,
      memoryUsage: {
        used: memUsage.heapUsed,
        total: memUsage.heapTotal,
        percentage: (memUsage.heapUsed / memUsage.heapTotal) * 100,
      },
      cpuUsage: process.cpuUsage().user / 1000000, // Convert to seconds
      activeUsers: 0, // Would need session tracking
      errorRate,
      responseTime: avgResponseTime,
      cacheHitRate: 0, // Would need cache metrics
    };
  }

  private getSystemResourceMetrics(): SystemResourceMetrics {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    return {
      cpu: {
        usage: 0, // Would need more sophisticated CPU monitoring
        loadAverage: os.loadavg(),
        cores: os.cpus().length,
      },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percentage: (usedMem / totalMem) * 100,
      },
      disk: {
        total: 0, // Would need disk space monitoring
        used: 0,
        free: 0,
        percentage: 0,
      },
      network: {
        bytesReceived: 0, // Would need network monitoring
        bytesSent: 0,
        connectionsActive: 0,
      },
    };
  }

  private async getBusinessHealthMetrics(): Promise<BusinessHealthMetrics> {
    try {
      const [
        totalMembers,
        activeLoans,
        totalLoanAmount,
        activeDeposits,
        totalDepositAmount,
        dailyTransactions,
      ] = await Promise.all([
        this.memberRepository.count({ where: { status: 'ACTIVE' } }),
        this.loanAccountRepository.count({ where: { status: 'ACTIVE' } }),
        this.loanAccountRepository
          .createQueryBuilder('loan')
          .select('SUM(loan.outstandingBalance)', 'total')
          .where('loan.status = :status', { status: 'ACTIVE' })
          .getRawOne()
          .then(result => parseFloat(result.total) || 0),
        this.fixedDepositRepository.count({ where: { status: 'ACTIVE' } }),
        this.fixedDepositRepository
          .createQueryBuilder('deposit')
          .select('SUM(deposit.principalAmount)', 'total')
          .where('deposit.status = :status', { status: 'ACTIVE' })
          .getRawOne()
          .then(result => parseFloat(result.total) || 0),
        this.transactionRepository.count({
          where: {
            transactionDate: new Date(new Date().toDateString()),
          },
        }),
      ]);

      // Calculate defaulters (loans overdue by more than 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const defaulterCount = await this.loanAccountRepository.count({
        where: {
          status: 'ACTIVE',
          maturityDate: LessThan(thirtyDaysAgo) as any,
        },
      });

      return {
        totalMembers,
        activeLoans,
        totalLoanAmount,
        activeDeposits,
        totalDepositAmount,
        dailyTransactions,
        defaulterCount,
        systemUtilization: (activeLoans + activeDeposits) / Math.max(totalMembers, 1) * 100,
      };
    } catch (error) {
      this.logger.error('Business health metrics collection failed', error.stack);
      return {
        totalMembers: 0,
        activeLoans: 0,
        totalLoanAmount: 0,
        activeDeposits: 0,
        totalDepositAmount: 0,
        dailyTransactions: 0,
        defaulterCount: 0,
        systemUtilization: 0,
      };
    }
  }

  private calculateOverallHealth(
    database: DatabaseHealthMetrics,
    application: ApplicationHealthMetrics,
    system: SystemResourceMetrics,
    business: BusinessHealthMetrics,
  ): OverallHealthStatus {
    const criticalIssues: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    let score = 100;

    // Database health scoring
    if (database.connectionStatus === 'CRITICAL') {
      criticalIssues.push('Database connection is critical');
      score -= 30;
    } else if (database.connectionStatus === 'WARNING') {
      warnings.push('Database connection is slow');
      score -= 10;
    }

    if (database.dataIntegrity.status === 'CRITICAL_ISSUES') {
      criticalIssues.push('Critical data integrity issues found');
      score -= 25;
    } else if (database.dataIntegrity.status === 'ISSUES_FOUND') {
      warnings.push('Data integrity issues found');
      score -= 10;
    }

    // Application health scoring
    if (application.memoryUsage.percentage > 90) {
      criticalIssues.push('Memory usage is critically high');
      score -= 20;
    } else if (application.memoryUsage.percentage > 75) {
      warnings.push('Memory usage is high');
      score -= 10;
    }

    if (application.errorRate > 10) {
      criticalIssues.push('Error rate is too high');
      score -= 15;
    } else if (application.errorRate > 5) {
      warnings.push('Error rate is elevated');
      score -= 5;
    }

    // System resource scoring
    if (system.memory.percentage > 95) {
      criticalIssues.push('System memory is critically low');
      score -= 20;
    } else if (system.memory.percentage > 85) {
      warnings.push('System memory is low');
      score -= 10;
    }

    // Business metrics scoring
    if (business.defaulterCount > business.activeLoans * 0.1) {
      warnings.push('High number of defaulters');
      score -= 15;
    }

    // Generate recommendations
    if (warnings.length > 0 || criticalIssues.length > 0) {
      recommendations.push('Run system diagnostics to identify specific issues');
      recommendations.push('Consider scheduling maintenance during off-peak hours');
    }

    if (application.memoryUsage.percentage > 75) {
      recommendations.push('Consider increasing application memory allocation');
    }

    if (database.queryPerformance.averageResponseTime > 1000) {
      recommendations.push('Optimize database queries and consider indexing');
    }

    // Determine overall status
    let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'DOWN' = 'HEALTHY';
    if (criticalIssues.length > 0) {
      status = 'CRITICAL';
    } else if (warnings.length > 0) {
      status = 'WARNING';
    }

    if (database.connectionStatus === 'CRITICAL') {
      status = 'DOWN';
      score = 0;
    }

    return {
      status,
      score: Math.max(0, score),
      criticalIssues,
      warnings,
      recommendations,
    };
  }

  private async checkForAlerts(healthMetrics: SystemHealthMetrics): Promise<void> {
    const now = new Date();

    // Check for critical database issues
    if (healthMetrics.database.connectionStatus === 'CRITICAL') {
      this.createAlert('CRITICAL', 'Database', 'Database connection is critical', now);
    }

    // Check for high memory usage
    if (healthMetrics.application.memoryUsage.percentage > 90) {
      this.createAlert('CRITICAL', 'Application', 'Memory usage is critically high', now);
    } else if (healthMetrics.application.memoryUsage.percentage > 75) {
      this.createAlert('WARNING', 'Application', 'Memory usage is high', now);
    }

    // Check for high error rate
    if (healthMetrics.application.errorRate > 10) {
      this.createAlert('CRITICAL', 'Application', 'Error rate is too high', now);
    }

    // Check for data integrity issues
    if (healthMetrics.database.dataIntegrity.status === 'CRITICAL_ISSUES') {
      this.createAlert('CRITICAL', 'Database', 'Critical data integrity issues found', now);
    }
  }

  private createAlert(
    type: 'CRITICAL' | 'WARNING' | 'INFO',
    component: string,
    message: string,
    timestamp: Date,
  ): void {
    const alertId = `${component}-${type}-${timestamp.getTime()}`;

    // Check if similar alert already exists
    const existingAlert = this.activeAlerts.find(
      alert => alert.component === component && alert.message === message && !alert.resolved
    );

    if (!existingAlert) {
      const alert: HealthAlert = {
        id: alertId,
        type,
        component,
        message,
        timestamp,
        resolved: false,
      };

      this.activeAlerts.push(alert);
      this.logger.warn(`Health Alert [${type}] ${component}: ${message}`);
    }
  }

  private generateSystemRecommendations(
    healthStatus: SystemHealthMetrics,
    consistencyReport: any,
  ): string[] {
    const recommendations: string[] = [];

    // Add health-based recommendations
    recommendations.push(...healthStatus.overall.recommendations);

    // Add consistency-based recommendations
    if (consistencyReport.recommendations) {
      recommendations.push(...consistencyReport.recommendations);
    }

    // Add performance recommendations
    const performanceMetrics = this.getPerformanceMetrics();
    const slowEndpoints = performanceMetrics.filter(m => m.averageResponseTime > 2000);

    if (slowEndpoints.length > 0) {
      recommendations.push('Optimize slow API endpoints for better performance');
    }

    // Add business recommendations
    if (healthStatus.business.defaulterCount > 0) {
      recommendations.push('Review and follow up on defaulter accounts');
    }

    if (healthStatus.business.systemUtilization < 50) {
      recommendations.push('Consider member engagement initiatives to increase system utilization');
    }

    return [...new Set(recommendations)]; // Remove duplicates
  }

  private startPeriodicMonitoring(): void {
    // Run health check every 5 minutes
    setInterval(async () => {
      try {
        await this.getCurrentHealthStatus();
      } catch (error) {
        this.logger.error('Periodic health check failed', error.stack);
      }
    }, 5 * 60 * 1000);

    // Clean up old performance metrics every hour
    setInterval(() => {
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      for (const [key, metrics] of this.performanceMetrics.entries()) {
        if (metrics.lastAccessed < cutoffTime) {
          this.performanceMetrics.delete(key);
        }
      }
    }, 60 * 60 * 1000);
  }
}
