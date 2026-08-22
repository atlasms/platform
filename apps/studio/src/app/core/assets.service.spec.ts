import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { API_BASE_URL } from './api.ts';
import { AssetsService } from './assets.service.ts';
import type { Asset } from './generated/mam.types.ts';

const asset: Asset = {
  id: '01K00000000000000000000000',
  channelId: 'ch12',
  title: 'Bulletin',
  mediaType: 'video',
  fileType: 'mxf',
  state: 'ready',
  version: 1,
  hasRenditions: true,
  createdBy: 'u1',
  createdAt: '2026-08-17T08:00:00.000Z',
  updatedAt: '2026-08-17T08:00:00.000Z',
};

describe('AssetsService', () => {
  it('adapts MAM search arrays to the page shape the Media panel consumes', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/gateway' },
      ],
    });
    const service = TestBed.inject(AssetsService);
    const http = TestBed.inject(HttpTestingController);
    let result: unknown;

    service.search('morning news', 12).subscribe((page) => (result = page));
    const request = http.expectOne(
      (candidate) =>
        candidate.url === '/gateway/api/v1/search' &&
        candidate.params.get('q') === 'morning news' &&
        candidate.params.get('limit') === '12',
    );
    expect(request.request.method).toBe('GET');
    request.flush([asset]);

    expect(result).toEqual({ items: [asset] });
    http.verify();
  });

  it('uses the contract-required asset id for detail reads and partial updates', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const service = TestBed.inject(AssetsService);
    const http = TestBed.inject(HttpTestingController);

    service.get('asset/with slash').subscribe();
    const get = http.expectOne('/api/v1/assets/asset%2Fwith%20slash');
    expect(get.request.method).toBe('GET');
    get.flush(asset);

    service.update(asset.id, { title: 'Renamed' }).subscribe();
    const patch = http.expectOne(`/api/v1/assets/${asset.id}`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ title: 'Renamed' });
    patch.flush({ ...asset, title: 'Renamed', version: 2 });
    http.verify();
  });
});
