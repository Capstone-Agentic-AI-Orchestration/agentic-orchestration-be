import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseAuthService } from './supabase-auth.service';
import { AuthenticatedRequest } from './auth.types';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly authService: SupabaseAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.getBearerToken(request);
    request.user = await this.authService.verifyAccessToken(token);
    return true;
  }

  private getBearerToken(request: AuthenticatedRequest): string {
    const header = request.headers.authorization;
    if (!header) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Authorization must use Bearer token');
    }

    return token;
  }
}
