// The transcode jobs client: one call, on the contract's operation, by method and URL.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TranscodeJobsService } from './transcode-jobs.service.ts';

describe('TranscodeJobsService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads one asset’s jobs from MTS through the gateway', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const service = TestBed.inject(TranscodeJobsService);
    const http = TestBed.inject(HttpTestingController);

    service.forAsset('01K00000000000000000000000').subscribe();
    const req = http.expectOne((r) => r.url === '/api/v1/jobs' && r.method === 'GET');
    expect(req.request.params.get('assetId')).toBe('01K00000000000000000000000');
    expect(req.request.params.get('limit')).toBe('50');
    req.flush([]);
    http.verify();
  });
});
