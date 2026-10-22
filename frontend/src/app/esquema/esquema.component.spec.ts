import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EsquemaComponent } from './esquema.component';

describe('EsquemaComponent', () => {
  let component: EsquemaComponent;
  let fixture: ComponentFixture<EsquemaComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EsquemaComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(EsquemaComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
