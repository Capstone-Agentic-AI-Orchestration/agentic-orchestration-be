import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { SearchProfilesDto } from './dto/search-profiles.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

export interface ProfileSearchResult {
  id: string;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  createdAt: Date;
}

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  me(user: AuthUser) {
    return this.prisma.profile.findUniqueOrThrow({
      where: { id: user.id },
      select: this.profileSelect(),
    });
  }

  updateMe(user: AuthUser, dto: UpdateProfileDto) {
    return this.prisma.profile.update({
      where: { id: user.id },
      data: {
        fullName: typeof dto.fullName === 'string' ? dto.fullName.trim() || null : undefined,
        preferences: dto.preferences === undefined ? undefined : (dto.preferences as Prisma.InputJsonValue),
      },
      select: this.profileSelect(),
    });
  }

  search(dto: SearchProfilesDto): Promise<ProfileSearchResult[]> {
    const query = dto.q?.trim();
    const limit = dto.limit ?? 20;
    const where: Prisma.ProfileWhereInput = {};

    if (dto.roles?.length) {
      where.role = { in: dto.roles };
    }

    if (query) {
      where.OR = [
        { email: { contains: query, mode: 'insensitive' } },
        { fullName: { contains: query, mode: 'insensitive' } },
      ];
    }

    return this.prisma.profile.findMany({
      where,
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
      },
      orderBy: [
        { role: 'asc' },
        { email: 'asc' },
      ],
      take: limit,
    });
  }

  private profileSelect() {
    return {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      preferences: true,
      createdAt: true,
      updatedAt: true,
    } satisfies Prisma.ProfileSelect;
  }
}
