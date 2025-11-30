import { SetMetadata } from '@nestjs/common';

export enum UserRole {
  ADMIN = 'admin',
  MANAGER = 'manager',
  LOAN_OFFICER = 'loan_officer',
  ACCOUNTANT = 'accountant',
  DATA_ENTRY = 'data_entry',
  VIEWER = 'viewer',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
