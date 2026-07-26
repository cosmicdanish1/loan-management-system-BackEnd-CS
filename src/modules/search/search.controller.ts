import { Controller, Get, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { SearchService, SearchResult } from './search.service';

@ApiTags('Search')
@Controller('search')
export class SearchController {
  private readonly logger = new Logger(SearchController.name);

  constructor(private readonly searchService: SearchService) {}

  @Get('global')
  @ApiOperation({ summary: 'Global search across all data types' })
  @ApiQuery({ name: 'q', type: 'string', description: 'Search query' })
  @ApiQuery({ name: 'type', type: 'string', required: false, description: 'Search type filter', enum: ['all', 'member', 'account', 'transaction', 'loan'] })
  @ApiQuery({ name: 'limit', type: 'number', required: false, description: 'Maximum results to return' })
  @ApiResponse({
    status: 200,
    description: 'Search results retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['member', 'account', 'transaction', 'loan'] },
              title: { type: 'string' },
              subtitle: { type: 'string' },
              details: { type: 'string' },
              date: { type: 'string' },
              relevance: { type: 'number' }
            }
          }
        }
      }
    }
  })
  async globalSearch(
    @Query('q') query: string,
    @Query('type') type: string = 'all',
    @Query('limit') limit: number = 50
  ): Promise<{ success: boolean; data: SearchResult[] }> {
    try {
      this.logger.debug(`Search API called: query="${query}", type="${type}", limit=${limit}`);

      if (!query || query.trim().length === 0) {
        return { success: true, data: [] };
      }

      const results = await this.searchService.globalSearch(query.trim(), type, limit);

      this.logger.debug(`Search returned ${results.length} results`);

      return {
        success: true,
        data: results
      };
    } catch (error) {
      this.logger.error(`Error in search controller: ${error.message}`, error.stack);
      return { success: false, data: [] };
    }
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Get search suggestions' })
  @ApiQuery({ name: 'q', type: 'string', description: 'Search query for suggestions' })
  @ApiQuery({ name: 'limit', type: 'number', required: false, description: 'Maximum suggestions to return' })
  async getSearchSuggestions(
    @Query('q') query: string,
    @Query('limit') limit: number = 5
  ): Promise<{ success: boolean; data: string[] }> {
    try {
      this.logger.debug(`Suggestions API called for: "${query}"`);

      if (!query || query.trim().length < 2) {
        return { success: true, data: [] };
      }

      const suggestions = await this.searchService.getSearchSuggestions(query.trim(), limit);

      this.logger.debug(`Returned ${suggestions.length} suggestions`);
      
      return {
        success: true,
        data: suggestions
      };
    } catch (error) {
      this.logger.error(`Error getting search suggestions: ${error.message}`, error.stack);
      return { success: false, data: [] };
    }
  }
}