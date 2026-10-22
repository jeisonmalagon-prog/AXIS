import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AppMovilComponent } from './app-movil.component';

describe('AppMovilComponent', () => {
  let component: AppMovilComponent;
  let fixture: ComponentFixture<AppMovilComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppMovilComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(AppMovilComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
