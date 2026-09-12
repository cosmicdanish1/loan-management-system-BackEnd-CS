import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { SearchService, SearchResult } from './search.service';

@ApiTags('Search')
@Controller('search')
export class SearchController {
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
      console.log(`🔍 [CONTROLLER] Search API called`);
      console.log(`🔍 [CONTROLLER] Query: "${query}"`);
      console.log(`🔍 [CONTROLLER] Type: "${type}"`);
      console.log(`🔍 [CONTROLLER] Limit: ${limit}`);
      
      if (!query || query.trim().length === 0) {
        console.log(`🔍 [CONTROLLER] Empty query, returning empty results`);
        return { success: true, data: [] };
      }

      console.log(`🔍 [CONTROLLER] Calling searchService.globalSearch...`);
      const results = await this.searchService.globalSearch(query.trim(), type, limit);
      
      console.log(`✅ [CONTROLLER] SearchService returned ${results.length} results`);
      console.log(`✅ [CONTROLLER] Sample result:`, results[0]);
      
      const response = {
        success: true,
        data: results
      };
      
      console.log(`✅ [CONTROLLER] Final API response:`, {
        success: response.success,
        dataLength: response.data.length,
        dataType: typeof response.data,
        isArray: Array.isArray(response.data)
      });
      
      return response;
    } catch (error) {
      console.error('❌ [CONTROLLER] Error in search controller:', error);
      console.error('❌ [CONTROLLER] Error details:', {
        message: error.message,
        stack: error.stack,
        query,
        type,
        limit
      });
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
      console.log(`🔍 [CONTROLLER] Suggestions API called for: "${query}"`);
      
      if (!query || query.trim().length < 2) {
        console.log(`🔍 [CONTROLLER] Query too short for suggestions`);
        return { success: true, data: [] };
      }

      console.log(`🔍 [CONTROLLER] Calling searchService.getSearchSuggestions...`);
      const suggestions = await this.searchService.getSearchSuggestions(query.trim(), limit);
      
      console.log(`✅ [CONTROLLER] SearchService returned ${suggestions.length} suggestions`);
      
      return {
        success: true,
        data: suggestions
      };
    } catch (error) {
      console.error('❌ [CONTROLLER] Error getting search suggestions:', error);
      console.error('❌ [CONTROLLER] Error details:', {
        message: error.message,
        stack: error.stack,
        query,
        limit
      });
      return { success: false, data: [] };
    }
  }
}