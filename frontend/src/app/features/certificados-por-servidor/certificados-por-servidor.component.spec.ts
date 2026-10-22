import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CertificadosPorServidorComponent } from './certificados-por-servidor.component';
import { HttpClientTestingModule } from '@angular/common/http/testing';

describe('CertificadosPorServidorComponent', () => {
  let component: CertificadosPorServidorComponent;
  let fixture: ComponentFixture<CertificadosPorServidorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CertificadosPorServidorComponent, HttpClientTestingModule]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CertificadosPorServidorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
