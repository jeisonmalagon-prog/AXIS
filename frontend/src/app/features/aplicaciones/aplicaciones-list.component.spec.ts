import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AplicacionesListComponent } from './aplicaciones-list.component';
import { HttpClientTestingModule } from '@angular/common/http/testing';

describe('AplicacionesListComponent', () => {
  let component: AplicacionesListComponent;
  let fixture: ComponentFixture<AplicacionesListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AplicacionesListComponent, HttpClientTestingModule]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(AplicacionesListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
