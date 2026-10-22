import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ServidoresListComponent } from './servidores-list.component';
import { HttpClientTestingModule } from '@angular/common/http/testing';

describe('ServidoresListComponent', () => {
  let component: ServidoresListComponent;
  let fixture: ComponentFixture<ServidoresListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ServidoresListComponent, HttpClientTestingModule]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(ServidoresListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
