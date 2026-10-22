import { ComponentFixture, TestBed } from '@angular/core/testing';

import { N8nComponent } from './n8n.component';

describe('N8nComponent', () => {
  let component: N8nComponent;
  let fixture: ComponentFixture<N8nComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [N8nComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(N8nComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
