import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('bankmas')
export class BankMember {
    @PrimaryColumn({ name: 'gmst_code', type: 'float8' })
    memberNo: number;

    @Column({ name: 'name', length: 255, nullable: true })
    name: string;

    @Column({ name: 'dept_code', length: 255, nullable: true })
    officeId: string; // Mapping dept_code as office/branch identifier

    @Column({ name: 'mobilno', length: 255, nullable: true })
    mobileNo: string;

    @Column({ name: 'emailadd', length: 255, nullable: true })
    email: string;
}
