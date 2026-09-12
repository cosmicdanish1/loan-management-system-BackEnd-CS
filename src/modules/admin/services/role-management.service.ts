import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { UserLevelMaster, MenuMaster, UserLevelDefaultRights } from '../../auth/entities';
import { UpdateDefaultRightsDto } from '../dto/role-management.dto';

@Injectable()
export class RoleManagementService {
    constructor(
        @InjectRepository(UserLevelMaster)
        private userLevelRepository: Repository<UserLevelMaster>,
        @InjectRepository(MenuMaster)
        private menuRepository: Repository<MenuMaster>,
        @InjectRepository(UserLevelDefaultRights)
        private defaultRightsRepository: Repository<UserLevelDefaultRights>,
        private dataSource: DataSource,
    ) { }

    async onModuleInit() {
        await this.seedStandardData();
    }

    private async seedStandardData() {
        try {
            // 1. Seed User Levels if missing
            const standardLevels = [
                { id: 1, name: 'SYSTEM' },
                { id: 2, name: 'ADMINISTRATOR' },
                { id: 3, name: 'BRANCH MANAGER' },
                { id: 4, name: 'OFFICER' },
                { id: 5, name: 'PASSING OFFICER' },
                { id: 6, name: 'CLERK' },
                { id: 7, name: 'AUDITOR' },
                { id: 8, name: 'CASHIER' },
                { id: 9, name: 'DATA OPERATOR' },
                { id: 10, name: 'USER' },
            ];

            for (const level of standardLevels) {
                let existing = await this.userLevelRepository.findOne({ where: { userlevelid: level.id } });
                if (!existing) {
                    existing = await this.userLevelRepository.findOne({ where: { userlevel: level.name } });
                }

                if (!existing) {
                    const newLevel = this.userLevelRepository.create({
                        userlevelid: level.id,
                        userlevel: level.name,
                    });
                    await this.userLevelRepository.save(newLevel);
                }
            }

            // 2. Seed Menus (Windows) if missing
            const standardMenus = [
                { id: 1, name: 'Cash Book', desc: '1.2' },
                { id: 2, name: 'Day Book', desc: '1.3' },
                { id: 3, name: 'Day Book [SB]', desc: '1.4' },
                { id: 4, name: 'Consolidation of Daily A/c', desc: '1.5' },
                { id: 5, name: 'Financial Year Closing', desc: '2' },
                { id: 6, name: 'General Ledger', desc: '3' },
                { id: 7, name: 'Member Ledger Report', desc: '4' },
                { id: 8, name: 'Print Vouchers', desc: '5' },
                { id: 9, name: 'Receipt / Payment Voucher', desc: '5.1' },
                { id: 10, name: 'Journal / Transfer Voucher', desc: '5.2' },
                { id: 11, name: 'Wing / Office List', desc: '6' },
                { id: 12, name: 'Cash Book Monthly', desc: '7' },
                { id: 13, name: 'Detail Ledger', desc: '8' },
                { id: 14, name: 'Bank Detail Ledger', desc: '9' },
                { id: 15, name: 'Wing Offices', desc: '10' },
                { id: 16, name: 'P&L / Balance Sheet', desc: '11' },
                { id: 17, name: 'FD Statement', desc: '12' },
                { id: 18, name: 'Member Statement', desc: '13' },
                { id: 19, name: 'About', desc: '14' },
                { id: 20, name: 'Backup Database', desc: '15' },
                { id: 21, name: 'Calculator', desc: '16' },
                { id: 22, name: 'Change Loan Surety', desc: '17' },
                { id: 23, name: 'Change Member Office', desc: '18' },
                { id: 24, name: 'Change Password', desc: '19' },
                { id: 25, name: 'Configure User Level Default Rights', desc: '20' },
                { id: 26, name: 'Create / Modify Users', desc: '21' },
                { id: 27, name: 'Day End', desc: '22' },
                { id: 28, name: 'Demand Print Order', desc: '23' },
                { id: 29, name: 'Deposit / Loan Slab', desc: '24' },
                { id: 30, name: 'Dividend Payment', desc: '25' },
                { id: 31, name: 'Member Master', desc: '59' },
                { id: 32, name: 'Loan Application', desc: '54' },
                { id: 33, name: 'Loan Scrutiny / Sanction', desc: '56' },
                { id: 34, name: 'Loan Payment', desc: '55' },
                { id: 35, name: 'Receipt', desc: '69' },
                { id: 36, name: 'Saving A/c Opening', desc: '71' },
                { id: 37, name: 'RD A/c Opening', desc: '68' },
                { id: 38, name: 'Fixed Deposit Entry', desc: '28' },
                { id: 39, name: 'FD Withdrawal / Interest', desc: '27' },
                { id: 40, name: 'Member Balance', desc: '58' },
                { id: 41, name: 'Surety Register', desc: '78' },
                { id: 42, name: 'Deposit Due Date Register', desc: '79' },
                { id: 43, name: 'Voucher Payment', desc: '75' },
                { id: 44, name: 'Pass Transactions', desc: '65' },
                { id: 45, name: 'Journal / Transfer Entry', desc: '53' },
            ];

            for (const menu of standardMenus) {
                const existing = await this.menuRepository.findOne({ where: { menuid: menu.id } });
                if (!existing) {
                    const newMenu = this.menuRepository.create({
                        menuid: menu.id,
                        menuname: menu.name,
                        menudesc: menu.desc,
                        visibleflag: 'Y'
                    });
                    await this.menuRepository.save(newMenu);
                }
            }

            console.log('Role Management standard data seeded successfully.');
        } catch (err) {
            console.error('Failed to seed Role Management data:', err.message);
        }
    }

    async findAllUserLevels(): Promise<UserLevelMaster[]> {
        return this.userLevelRepository.find({
            order: { userlevelid: 'ASC' }
        });
    }

    async findAllMenus() {
        return this.menuRepository.find({
            order: { menuid: 'ASC' }
        });
    }

    async getDefaultRights(userLevelId: number) {
        const rights = await this.defaultRightsRepository.find({
            where: { userlevelid: userLevelId },
        });
        return rights.map(r => r.menuid);
    }

    async updateDefaultRights(updateDto: UpdateDefaultRightsDto) {
        const { userlevelid, menuIds } = updateDto;

        // Check if user level exists
        const userLevel = await this.userLevelRepository.findOne({
            where: { userlevelid }
        });
        if (!userLevel) {
            throw new NotFoundException(`User level with ID ${userlevelid} not found`);
        }

        await this.dataSource.transaction(async (manager) => {
            await manager.delete(UserLevelDefaultRights, { userlevelid });

            if (menuIds.length > 0) {
                const newRights = menuIds.map(menuid =>
                    manager.create(UserLevelDefaultRights, { userlevelid, menuid })
                );
                await manager.save(UserLevelDefaultRights, newRights);
            }
        });

        return {
            message: 'Default rights updated successfully',
            userlevelid,
            count: menuIds.length
        };
    }
}
