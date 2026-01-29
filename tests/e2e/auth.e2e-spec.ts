import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import * as request from 'supertest';
import { AuthModule } from '../src/modules/auth/auth.module';
import { User, UserRole } from '../src/modules/auth/entities/user.entity';
import { DatabaseConfig } from '../src/config/database.config';

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  let createdUserId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test', // Use test environment variables
        }),
        TypeOrmModule.forRootAsync({
          useClass: DatabaseConfig,
        }),
        AuthModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    // Clean up test data
    if (createdUserId) {
      const userRepository = app.get('UserRepository');
      await userRepository.delete(createdUserId);
    }
    await app.close();
  });

  describe('/auth/register (POST)', () => {
    it('should register a new user', () => {
      const registerDto = {
        username: 'testuser_e2e',
        email: 'test_e2e@example.com',
        password: 'TestPassword123!',
        firstName: 'Test',
        lastName: 'User',
        role: UserRole.DATA_OPERATOR,
      };

      return request(app.getHttpServer())
        .post('/auth/register')
        .send(registerDto)
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('accessToken');
          expect(res.body).toHaveProperty('refreshToken');
          expect(res.body).toHaveProperty('user');
          expect(res.body.user.username).toBe(registerDto.username);
          expect(res.body.user.email).toBe(registerDto.email);
          createdUserId = res.body.user.id;
        });
    });

    it('should return 409 when username already exists', () => {
      const registerDto = {
        username: 'testuser_e2e', // Same username as above
        email: 'different@example.com',
        password: 'TestPassword123!',
        firstName: 'Test',
        lastName: 'User',
      };

      return request(app.getHttpServer())
        .post('/auth/register')
        .send(registerDto)
        .expect(409);
    });

    it('should return 400 for invalid input', () => {
      const invalidDto = {
        username: '', // Empty username
        email: 'invalid-email', // Invalid email format
        password: '123', // Too short password
      };

      return request(app.getHttpServer())
        .post('/auth/register')
        .send(invalidDto)
        .expect(400);
    });
  });

  describe('/auth/login (POST)', () => {
    it('should login with valid credentials', () => {
      const loginDto = {
        username: 'testuser_e2e',
        password: 'TestPassword123!',
      };

      return request(app.getHttpServer())
        .post('/auth/login')
        .send(loginDto)
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('accessToken');
          expect(res.body).toHaveProperty('refreshToken');
          expect(res.body).toHaveProperty('user');
          expect(res.body.user.username).toBe(loginDto.username);
        });
    });

    it('should return 401 for invalid credentials', () => {
      const loginDto = {
        username: 'testuser_e2e',
        password: 'WrongPassword',
      };

      return request(app.getHttpServer())
        .post('/auth/login')
        .send(loginDto)
        .expect(401);
    });

    it('should return 400 for missing credentials', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({})
        .expect(400);
    });
  });

  describe('/auth/me (GET)', () => {
    let accessToken: string;

    beforeAll(async () => {
      // Login to get access token
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'testuser_e2e',
          password: 'TestPassword123!',
        });
      
      accessToken = loginResponse.body.accessToken;
    });

    it('should return current user profile with valid token', () => {
      return request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('id');
          expect(res.body).toHaveProperty('username');
          expect(res.body).toHaveProperty('email');
          expect(res.body.username).toBe('testuser_e2e');
        });
    });

    it('should return 401 without token', () => {
      return request(app.getHttpServer())
        .get('/auth/me')
        .expect(401);
    });

    it('should return 401 with invalid token', () => {
      return request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);
    });
  });

  describe('/auth/refresh (POST)', () => {
    let refreshToken: string;

    beforeAll(async () => {
      // Login to get refresh token
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'testuser_e2e',
          password: 'TestPassword123!',
        });
      
      refreshToken = loginResponse.body.refreshToken;
    });

    it('should refresh token with valid refresh token', () => {
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('accessToken');
          expect(res.body).toHaveProperty('refreshToken');
          expect(res.body).toHaveProperty('user');
        });
    });

    it('should return 401 with invalid refresh token', () => {
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'invalid-refresh-token' })
        .expect(401);
    });
  });

  describe('/auth/logout (POST)', () => {
    let accessToken: string;

    beforeAll(async () => {
      // Login to get access token
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'testuser_e2e',
          password: 'TestPassword123!',
        });
      
      accessToken = loginResponse.body.accessToken;
    });

    it('should logout with valid token', () => {
      return request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('message');
          expect(res.body.message).toBe('Logout successful');
        });
    });

    it('should return 401 without token', () => {
      return request(app.getHttpServer())
        .post('/auth/logout')
        .expect(401);
    });
  });
});