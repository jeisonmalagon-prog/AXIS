import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CertificadosListComponent } from './certificados-list.component';
import { HttpClientTestingModule } from '@angular/common/http/testing';

describe('CertificadosListComponent', () => {
  let component: CertificadosListComponent;
  let fixture: ComponentFixture<CertificadosListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CertificadosListComponent, HttpClientTestingModule]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(CertificadosListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
